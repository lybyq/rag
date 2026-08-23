/**
 * 评测 Case 到真实 RagRun 的 Adapter。
 *
 * 它恢复数据集创建人的可信身份，调用正常 RagRunService 创建问答，并从受控评测事实表、
 * 引用表与 Validator 报告构造标准化实际结果。普通用户消息接口不会读取这些隐藏候选。
 *
 * @requirement OPS-002
 * @requirement OPS-003
 * @requirement OPS-006
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  AUTHORIZATION_VERSION_PROVIDER,
  evaluationCaseIdempotencyKey,
  RagRunService,
  type AccessContext,
  type ClaimedEvaluationCase,
  type EvaluationQuestionRunnerPort,
} from '@rag/application';
import { rehydrateRunUserContext } from '@rag/auth';
import { EvaluationActualSchema, type AuthorizationVersionPort } from '@rag/contracts';
import { POSTGRES_POOL } from '@rag/persistence-pg';
import type { Pool } from 'pg';

interface ActualRow {
  run_status: string;
  failure_code: string | null;
  created_at: Date;
  completed_at: Date | null;
  retrieved_document_ids: string[] | null;
  retrieved_chunk_ids: string[] | null;
  claims: unknown | null;
  security_violations: string[] | null;
  evidence_route: string | null;
  final_status: string | null;
  citation_document_ids: string[] | null;
}

/** 真实问答评测执行 Adapter。 */
@Injectable()
export class RagRunEvaluationQuestionRunner implements EvaluationQuestionRunnerPort {
  public constructor(
    @Inject(RagRunService) private readonly runs: RagRunService,
    @Inject(AUTHORIZATION_VERSION_PROVIDER)
    private readonly authorizationVersion: AuthorizationVersionPort,
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
  ) {}

  /** 创建评测专用会话和正常异步 Run；稳定幂等键先复用已存在事实。 */
  public async start(task: ClaimedEvaluationCase): Promise<string> {
    const idempotencyKey = evaluationCaseIdempotencyKey(task);
    const existing = await this.pool.query<{ id: string }>(
      'SELECT id FROM rag_runs WHERE owner_user_id=$1 AND idempotency_key=$2',
      [task.ownerUserId, idempotencyKey],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const context = await this.context(task);
    const conversation = await this.runs.createConversation(context, {
      title: `[评测] ${task.testCase.externalKey}`.slice(0, 200),
    });
    const accepted = await this.runs.createRun(context, conversation.id, idempotencyKey, {
      question: task.testCase.question ?? '评测事实检查',
      requestedSpaceIds: task.testCase.requestedSpaceIds,
    });
    return accepted.run.id;
  }

  /** 未终态只返回 PENDING；完成后从评测专用事实表构造 Actual。 */
  public async read(
    task: ClaimedEvaluationCase,
  ): Promise<Awaited<ReturnType<EvaluationQuestionRunnerPort['read']>>> {
    if (!task.ragRunId) return { status: 'PENDING' as const };
    const context = await this.context(task);
    const run = await this.runs.getRun(context, task.ragRunId);
    if (!['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(run.status)) {
      return { status: 'PENDING' as const };
    }
    if (run.status !== 'COMPLETED') {
      return { status: 'FAILED' as const, code: run.failureCode ?? `RAG_RUN_${run.status}` };
    }
    const result = await this.pool.query<ActualRow>(
      `SELECT run.status AS run_status,run.failure_code,run.created_at,run.completed_at,
              facts.retrieved_document_ids,facts.retrieved_chunk_ids,facts.claims,
              facts.security_violations,report.evidence_route,report.final_status,
              COALESCE(array_agg(DISTINCT citation.document_id)
                FILTER (WHERE citation.document_id IS NOT NULL),ARRAY[]::uuid[]) AS citation_document_ids
         FROM rag_runs run
         LEFT JOIN rag_run_evaluation_facts facts ON facts.run_id=run.id
         LEFT JOIN answer_validation_reports report ON report.run_id=run.id
         LEFT JOIN answer_citations citation ON citation.run_id=run.id
        WHERE run.id=$1 AND run.owner_user_id=$2
        GROUP BY run.id,facts.run_id,report.run_id`,
      [task.ragRunId, task.ownerUserId],
    );
    const row = result.rows[0];
    if (!row || !row.completed_at || !row.evidence_route || !row.final_status) {
      return { status: 'FAILED' as const, code: 'EVALUATION_FACTS_MISSING' };
    }
    const durationMs = Math.max(0, row.completed_at.getTime() - row.created_at.getTime());
    const actual = EvaluationActualSchema.parse({
      retrievedDocumentIds: row.retrieved_document_ids ?? [],
      retrievedChunkIds: row.retrieved_chunk_ids ?? [],
      citationDocumentIds: row.citation_document_ids ?? [],
      claims: row.claims ?? [],
      route: row.evidence_route,
      finalStatus: row.final_status,
      accessDecision: 'ALLOW',
      securityViolations: row.security_violations ?? [],
      responseLatencyMs: durationMs,
    });
    return { status: 'COMPLETED' as const, actual, durationMs };
  }

  private async context(task: ClaimedEvaluationCase): Promise<AccessContext> {
    const currentAuthzVersion = await this.authorizationVersion.getCurrentVersion();
    return {
      user: rehydrateRunUserContext({
        userId: task.ownerUserId,
        roles: task.ownerRoles,
        authzVersion: task.ownerAuthzVersion,
        currentAuthzVersion,
        expectedAuthzVersion: task.ownerAuthzVersion,
        expectedRolesSha256: task.ownerRolesSha256,
      }),
      requestId: `evaluation:${task.resultId}`,
    };
  }
}
