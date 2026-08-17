/**
 * M04 PostgreSQL 事实源 Adapter。
 * 它原子持久化 Chunk/关系/质量报告，使用 lease fencing 防止过期 Worker 提交，并用行锁、乐观锁和不可变审核历史保护人工结论。
 * 本文件不实现 Chunk 算法，也不调用模型或向量数据库。
 *
 * @requirement KNO-001
 * @requirement KNO-004
 * @requirement KNO-011
 * @requirement KNO-012
 * @requirement KNO-013
 * @requirement KNO-014
 */
import { decideQualityReview, IllegalQualityReviewError } from '@rag/chunking';
import {
  DocumentBlockSchema,
  DocumentQualityReportSchema,
  KnowledgeChunkSchema,
  KnowledgeProcessingRunSchema,
  QualityFindingSchema,
  type DocumentBlock,
  type DocumentQualityReport,
  type KnowledgeChunk,
  type KnowledgeProcessingRun,
  type ListKnowledgeChunksQuery,
  type QualityFinding,
} from '@rag/contracts';
import {
  ApplicationError,
  type AccessContext,
  type BeginKnowledgeProcessingCommand,
  type CompleteKnowledgeProcessingCommand,
  type FailKnowledgeProcessingCommand,
  type KnowledgeChunkPage,
  type KnowledgeProcessingInput,
  type KnowledgeProcessingRepository,
  type ReviewKnowledgeQualityCommand,
  type ReviewKnowledgeQualityResult,
} from '@rag/application';
import {
  createIngestionJobId,
  createIngestionStepId,
  INGESTION_STEP_ORDER,
  INGESTION_STEP_WEIGHTS,
} from '@rag/ingestion-core';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

interface ProcessingRunRow {
  id: string;
  job_id: string;
  parse_run_id: string;
  document_version_id: string;
  content_revision: number;
  file_format: string;
  status: string;
  chunker_profile_id: string;
  chunker_revision: string;
  tokenizer_profile_id: string;
  tokenizer_revision: string;
  quality_rule_version: string;
  parent_chunk_count: number;
  child_chunk_count: number;
  relation_count: number;
  failure_code: string | null;
  failure_message: string | null;
  metrics: Record<string, unknown>;
  started_at: Date | string;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BlockRow {
  id: string;
  parse_run_id: string;
  document_version_id: string;
  content_revision: number;
  ordinal: number;
  block_type: string;
  text_content: string;
  original_text: string;
  page_no: number | null;
  sheet_name: string | null;
  slide_no: number | null;
  bbox: unknown;
  heading_level: number | null;
  parent_block_id: string | null;
  confidence: string | number | null;
  table_data: unknown;
  parser_name: string;
  parser_revision: string;
  ocr_engine: string | null;
  ocr_revision: string | null;
  metadata: Record<string, unknown>;
  content_sha256: string;
  created_at: Date | string;
}

interface ChunkRow {
  id: string;
  processing_run_id: string;
  document_version_id: string;
  content_revision: number;
  ordinal: number;
  granularity: string;
  content_type: string;
  display_content: string;
  embedding_text: string;
  token_count: number;
  tokenizer_profile_id: string;
  tokenizer_revision: string;
  heading_path: unknown;
  source_locations: unknown;
  parent_chunk_id: string | null;
  content_sha256: string;
  dedup_status: string;
  duplicate_of_chunk_id: string | null;
  eligible_for_index: boolean;
  split_reason: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
}

interface ReportRow {
  id: string;
  processing_run_id: string;
  document_version_id: string;
  content_revision: number;
  verdict: string;
  rule_version: string;
  metrics: unknown;
  review_decision: string;
  review_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | string | null;
  optimistic_version: number;
  eligible_for_index: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

interface FindingRow {
  id: string;
  report_id: string;
  severity: string;
  code: string;
  message: string;
  page_nos: unknown;
  block_ids: unknown;
  chunk_ids: unknown;
  metadata: Record<string, unknown>;
  created_at: Date | string;
}

interface InputRow {
  job_id: string;
  document_id: string;
  document_version_id: string;
  job_content_revision: number;
  version_content_revision: number;
  parse_run_id: string;
  parse_content_revision: number;
  file_format: string;
  page_count: number;
  owner_user_id: string;
}

/** PostgreSQL M04 Repository。 */
@Injectable()
export class PostgresKnowledgeProcessingRepository implements KnowledgeProcessingRepository {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /** 只有当前 CHUNK lease owner 且 M03 CLEAN/SUCCEEDED 时才能读取 Block。 */
  public async loadInput(
    jobId: string,
    workerId: string,
  ): Promise<KnowledgeProcessingInput | undefined> {
    const result = await this.pool.query<InputRow>(
      `SELECT j.id AS job_id, j.document_id, j.document_version_id,
              j.content_revision AS job_content_revision,
              dv.content_revision AS version_content_revision,
              pr.id AS parse_run_id, pr.content_revision AS parse_content_revision,
              pr.file_format, pr.page_count, ks.owner_user_id
         FROM ingestion_jobs j
         JOIN document_versions dv ON dv.id = j.document_version_id
         JOIN documents d ON d.id = j.document_id
         JOIN knowledge_spaces ks ON ks.id = d.space_id
         JOIN document_parse_runs pr ON pr.job_id = j.id
        WHERE j.id = $1 AND j.status = 'RUNNING' AND j.current_step = 'CHUNK'
          AND j.lease_owner = $2 AND j.lease_expires_at > now()
          AND pr.status = 'SUCCEEDED' AND pr.security_verdict = 'CLEAN'
          AND pr.file_format IS NOT NULL`,
      [jobId, workerId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const blocks = await this.pool.query<BlockRow>(
      'SELECT * FROM document_blocks WHERE parse_run_id = $1 ORDER BY ordinal',
      [row.parse_run_id],
    );
    return {
      jobId: row.job_id,
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      contentRevision: row.job_content_revision,
      parseRunId: row.parse_run_id,
      fileFormat: KnowledgeProcessingRunSchema.shape.fileFormat.parse(row.file_format),
      expectedPageCount: row.page_count,
      hasResponsibleOwner: row.owner_user_id.trim().length > 0,
      versionConsistent:
        row.job_content_revision === row.version_content_revision &&
        row.job_content_revision === row.parse_content_revision &&
        blocks.rows.every((block) => block.content_revision === row.job_content_revision),
      blocks: blocks.rows.map(mapBlock),
    };
  }

  /** 幂等恢复同一 job 的运行记录，但不复用其他算法 revision 的历史结果。 */
  public async beginRun(command: BeginKnowledgeProcessingCommand): Promise<KnowledgeProcessingRun> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, command.input.jobId, command.workerId, 'CHUNK');
      const result = await client.query<ProcessingRunRow>(
        `INSERT INTO knowledge_processing_runs (
           job_id, parse_run_id, document_version_id, content_revision, file_format, status,
           chunker_profile_id, chunker_revision, tokenizer_profile_id, tokenizer_revision,
           quality_rule_version
         ) VALUES ($1,$2,$3,$4,$5,'RUNNING',$6,$7,$8,$9,$10)
         ON CONFLICT (job_id) DO UPDATE SET
           status = 'RUNNING', failure_code = NULL, failure_message = NULL,
           chunker_profile_id = EXCLUDED.chunker_profile_id,
           chunker_revision = EXCLUDED.chunker_revision,
           tokenizer_profile_id = EXCLUDED.tokenizer_profile_id,
           tokenizer_revision = EXCLUDED.tokenizer_revision,
           quality_rule_version = EXCLUDED.quality_rule_version,
           started_at = now(), completed_at = NULL, updated_at = now()
         RETURNING *`,
        [
          command.input.jobId,
          command.input.parseRunId,
          command.input.documentVersionId,
          command.input.contentRevision,
          command.input.fileFormat,
          command.chunkerProfileId,
          command.chunkerRevision,
          command.tokenizerProfileId,
          command.tokenizerRevision,
          command.qualityRuleVersion,
        ],
      );
      const row = requireRow(result.rows[0], 'M04 Run 创建失败');
      await client.query(
        `INSERT INTO protected_resource_spaces (resource_type, resource_id, space_id)
         SELECT 'KNOWLEDGE_RUN', $1, d.space_id
           FROM documents d WHERE d.id = $2
         ON CONFLICT (resource_type, resource_id) DO NOTHING`,
        [row.id, command.input.documentId],
      );
      await this.insertEvent(client, command.input.jobId, 'ingestion.m04_started', {
        processingRunId: row.id,
        contentRevision: command.input.contentRevision,
      });
      await client.query('COMMIT');
      return mapRun(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 更新真实单位进度；切到 QUALITY_GATE 时确定性完成 CHUNK。 */
  public async startStep(
    jobId: string,
    workerId: string,
    step: 'CHUNK' | 'QUALITY_GATE',
    processedUnits: number,
    totalUnits: number | null,
    publicMessage: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, jobId, workerId);
      if (step === 'QUALITY_GATE') {
        await client.query(
          `UPDATE ingestion_job_steps
              SET status = 'SUCCEEDED', processed_units = COALESCE(total_units, $2),
                  total_units = COALESCE(total_units, $2), stage_percent = 100,
                  overall_percent = 65, public_message = 'Chunk 已生成',
                  finished_at = COALESCE(finished_at, now()), updated_at = now()
            WHERE job_id = $1 AND step_name = 'CHUNK'`,
          [jobId, Math.max(1, processedUnits)],
        );
      }
      await client.query(
        `UPDATE ingestion_job_steps
            SET status = 'RUNNING', processed_units = $3::bigint, total_units = $4::bigint,
                stage_percent = CASE WHEN $4::bigint IS NULL THEN NULL
                  ELSE LEAST(100, ROUND((($3::bigint)::numeric / GREATEST($4::bigint, 1)) * 100, 2)) END,
                overall_percent = CASE WHEN $2 = 'CHUNK' THEN 50 ELSE 65 END,
                public_message = $5, started_at = COALESCE(started_at, now()),
                heartbeat_at = now(), updated_at = now()
          WHERE job_id = $1 AND step_name = $2`,
        [jobId, step, processedUnits, totalUnits, publicMessage],
      );
      await client.query(
        `UPDATE ingestion_jobs
            SET current_step = $3::varchar,
                overall_percent = CASE WHEN $3::varchar = 'CHUNK' THEN 50 ELSE 65 END,
                public_message = $4, heartbeat_at = now(), updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [jobId, workerId, step, publicMessage],
      );
      await this.insertEvent(client, jobId, 'ingestion.step_started', { step });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Chunk、关系、质量报告与下一状态在一个 lease-fenced 事务内落库。 */
  public async complete(command: CompleteKnowledgeProcessingCommand): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, command.jobId, command.workerId, 'QUALITY_GATE');
      await client.query(
        `DELETE FROM document_quality_findings WHERE report_id IN (
           SELECT id FROM document_quality_reports WHERE processing_run_id = $1
         )`,
        [command.processingRunId],
      );
      await client.query('DELETE FROM document_quality_reports WHERE processing_run_id = $1', [
        command.processingRunId,
      ]);
      await client.query('DELETE FROM chunk_relations WHERE processing_run_id = $1', [
        command.processingRunId,
      ]);
      await client.query('DELETE FROM knowledge_chunks WHERE processing_run_id = $1', [
        command.processingRunId,
      ]);

      const automaticallyEligible = command.quality.verdict === 'PASS';
      for (const chunk of [...command.chunks].sort((left, right) => left.ordinal - right.ordinal)) {
        const eligible =
          automaticallyEligible &&
          chunk.granularity === 'CHILD' &&
          chunk.dedupStatus !== 'SUPPRESSED_DUPLICATE';
        await client.query(
          `INSERT INTO knowledge_chunks (
             id, processing_run_id, document_version_id, content_revision, ordinal,
             granularity, content_type, display_content, embedding_text, token_count,
             tokenizer_profile_id, tokenizer_revision, heading_path, source_locations,
             parent_chunk_id, content_sha256, dedup_status, duplicate_of_chunk_id,
             eligible_for_index, split_reason, metadata
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,
             $17,$18,$19,$20,$21::jsonb
           )`,
          [
            chunk.id,
            command.processingRunId,
            chunk.documentVersionId,
            chunk.contentRevision,
            chunk.ordinal,
            chunk.granularity,
            chunk.contentType,
            chunk.displayContent,
            chunk.embeddingText,
            chunk.tokenCount,
            chunk.tokenizerProfileId,
            chunk.tokenizerRevision,
            JSON.stringify(chunk.headingPath),
            JSON.stringify(chunk.sourceLocations),
            chunk.parentChunkId,
            chunk.contentSha256,
            chunk.dedupStatus,
            chunk.duplicateOfChunkId,
            eligible,
            chunk.splitReason,
            JSON.stringify(chunk.metadata),
          ],
        );
      }
      for (const relation of command.relations) {
        await client.query(
          `INSERT INTO chunk_relations (
             processing_run_id, from_chunk_id, relation_type, to_chunk_id,
             to_block_id, ordinal, metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            command.processingRunId,
            relation.fromChunkId,
            relation.relationType,
            relation.toChunkId,
            relation.toBlockId,
            relation.ordinal,
            JSON.stringify(relation.metadata),
          ],
        );
      }

      const reviewDecision = command.quality.verdict === 'PASS' ? 'NOT_REQUIRED' : 'PENDING';
      const report = await client.query<ReportRow>(
        `INSERT INTO document_quality_reports (
           processing_run_id, document_version_id, content_revision, verdict,
           rule_version, metrics, review_decision, eligible_for_index
         ) SELECT $1, document_version_id, content_revision, $2, quality_rule_version,
                  $3::jsonb, $4, $5
             FROM knowledge_processing_runs WHERE id = $1
         RETURNING *`,
        [
          command.processingRunId,
          command.quality.verdict,
          JSON.stringify(command.quality.metrics),
          reviewDecision,
          automaticallyEligible,
        ],
      );
      const reportRow = requireRow(report.rows[0], '质量报告创建失败');
      for (const finding of command.quality.findings) {
        await client.query(
          `INSERT INTO document_quality_findings (
             report_id, severity, code, message, page_nos, block_ids, chunk_ids, metadata
           ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`,
          [
            reportRow.id,
            finding.severity,
            finding.code,
            finding.message,
            JSON.stringify(finding.pageNos),
            JSON.stringify(finding.blockIds),
            JSON.stringify(finding.chunkIds),
            JSON.stringify(finding.metadata),
          ],
        );
      }
      await this.finishAutomaticDecision(client, command);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 算法异常停在当前步骤等待排查，并释放 lease。 */
  public async fail(command: FailKnowledgeProcessingCommand): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, command.jobId, command.workerId);
      if (command.processingRunId) {
        await client.query(
          `UPDATE knowledge_processing_runs
              SET status = 'FAILED', failure_code = $2, failure_message = $3,
                  completed_at = now(), updated_at = now()
            WHERE id = $1`,
          [command.processingRunId, command.failureCode, command.publicMessage],
        );
      }
      await client.query(
        `UPDATE ingestion_job_steps
            SET status = 'WAITING', public_message = $3, finished_at = now(), updated_at = now()
          WHERE job_id = $1 AND step_name = (
            SELECT current_step FROM ingestion_jobs WHERE id = $1 AND lease_owner = $2
          )`,
        [command.jobId, command.workerId, command.publicMessage],
      );
      await client.query(
        `UPDATE ingestion_jobs
            SET status = 'WAITING', public_message = $3, lease_owner = NULL,
                lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [command.jobId, command.workerId, command.publicMessage],
      );
      await client.query(
        `UPDATE document_versions SET status = 'WAITING', updated_at = now()
          WHERE id = (SELECT document_version_id FROM ingestion_jobs WHERE id = $1)`,
        [command.jobId],
      );
      await this.insertEvent(client, command.jobId, 'ingestion.m04_failed', {
        processingRunId: command.processingRunId,
        failureCode: command.failureCode,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async listRuns(
    context: AccessContext,
    documentVersionId: string,
  ): Promise<readonly KnowledgeProcessingRun[]> {
    await this.assertVersionAccess(context, documentVersionId);
    const result = await this.pool.query<ProcessingRunRow>(
      `SELECT * FROM knowledge_processing_runs
        WHERE document_version_id = $1 ORDER BY content_revision DESC, created_at DESC`,
      [documentVersionId],
    );
    return result.rows.map(mapRun);
  }

  public async getRun(
    context: AccessContext,
    processingRunId: string,
  ): Promise<
    | {
        run: KnowledgeProcessingRun;
        report: DocumentQualityReport;
        findings: readonly QualityFinding[];
      }
    | undefined
  > {
    const runs = await this.pool.query<ProcessingRunRow>(
      'SELECT * FROM knowledge_processing_runs WHERE id = $1',
      [processingRunId],
    );
    const run = runs.rows[0];
    if (!run) return undefined;
    await this.assertVersionAccess(context, run.document_version_id);
    const reports = await this.pool.query<ReportRow>(
      'SELECT * FROM document_quality_reports WHERE processing_run_id = $1',
      [processingRunId],
    );
    const report = reports.rows[0];
    if (!report) return undefined;
    const findings = await this.pool.query<FindingRow>(
      `SELECT * FROM document_quality_findings
        WHERE report_id = $1 ORDER BY severity DESC, created_at, id`,
      [report.id],
    );
    return {
      run: mapRun(run),
      report: mapReport(report),
      findings: findings.rows.map(mapFinding),
    };
  }

  public async listChunks(
    context: AccessContext,
    processingRunId: string,
    query: ListKnowledgeChunksQuery,
  ): Promise<KnowledgeChunkPage> {
    const runs = await this.pool.query<{ document_version_id: string }>(
      'SELECT document_version_id FROM knowledge_processing_runs WHERE id = $1',
      [processingRunId],
    );
    const run = runs.rows[0];
    if (!run) throw new ApplicationError('NOT_FOUND', 404, '知识加工运行不存在');
    await this.assertVersionAccess(context, run.document_version_id);
    const result = await this.pool.query<ChunkRow>(
      `SELECT * FROM knowledge_chunks
        WHERE processing_run_id = $1 AND ordinal > $2
          AND ($3::text IS NULL OR granularity::text = $3::text)
        ORDER BY ordinal LIMIT $4`,
      [processingRunId, query.afterOrdinal, query.granularity ?? null, query.limit + 1],
    );
    const selected = result.rows.slice(0, query.limit).map(mapChunk);
    return {
      items: selected,
      nextOrdinal: result.rows.length > query.limit ? (selected.at(-1)?.ordinal ?? null) : null,
    };
  }

  /** 审核、索引资格、任务状态、审计和可选新 revision 在一个行锁事务内完成。 */
  public async review(
    command: ReviewKnowledgeQualityCommand,
  ): Promise<ReviewKnowledgeQualityResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<
        ReportRow & {
          run_status: string;
          job_id: string;
          document_id: string;
          space_id: string;
          version_content_revision: number;
          document_optimistic_version: number;
        }
      >(
        `SELECT qr.*, kpr.status AS run_status, kpr.job_id, j.document_id, d.space_id,
                dv.content_revision AS version_content_revision,
                dv.optimistic_version AS document_optimistic_version
           FROM document_quality_reports qr
           JOIN knowledge_processing_runs kpr ON kpr.id = qr.processing_run_id
           JOIN ingestion_jobs j ON j.id = kpr.job_id
           JOIN documents d ON d.id = j.document_id
           JOIN document_versions dv ON dv.id = qr.document_version_id
          WHERE qr.processing_run_id = $1
          FOR UPDATE OF qr, dv`,
        [command.processingRunId],
      );
      const current = result.rows[0];
      if (!current) throw new ApplicationError('NOT_FOUND', 404, '质量报告不存在');
      await this.assertReviewPermission(client, command.context, current.space_id);
      if (current.optimistic_version !== command.expectedVersion) {
        throw new ApplicationError('VERSION_CONFLICT', 409, '质量报告已被其他审核者更新');
      }

      let nextDecision: ReturnType<typeof decideQualityReview>;
      try {
        nextDecision = decideQualityReview(
          DocumentQualityReportSchema.shape.verdict.parse(current.verdict),
          DocumentQualityReportSchema.shape.reviewDecision.parse(current.review_decision),
          command.action,
        );
      } catch (error) {
        if (error instanceof IllegalQualityReviewError) {
          throw new ApplicationError('INVALID_STATE', 409, error.message);
        }
        throw error;
      }

      const approved = nextDecision === 'APPROVED';
      const updated = await client.query<ReportRow>(
        `UPDATE document_quality_reports
            SET review_decision = $2, review_reason = $3, reviewed_by = $4,
                reviewed_at = now(), optimistic_version = optimistic_version + 1,
                eligible_for_index = $5, updated_at = now()
          WHERE id = $1 AND optimistic_version = $6
        RETURNING *`,
        [
          current.id,
          nextDecision,
          command.reason,
          command.context.user.userId,
          approved,
          command.expectedVersion,
        ],
      );
      const report = requireRow(updated.rows[0], '审核版本冲突');
      await client.query(
        `UPDATE knowledge_chunks
            SET eligible_for_index = $2 AND granularity = 'CHILD'
                AND dedup_status <> 'SUPPRESSED_DUPLICATE'
          WHERE processing_run_id = $1`,
        [command.processingRunId, approved],
      );

      let reprocessJobId: string | null = null;
      if (nextDecision === 'APPROVED') {
        await this.finishApprovedReview(client, current.job_id, command.processingRunId);
      } else {
        await this.finishRejectedReview(
          client,
          current.job_id,
          command.processingRunId,
          command.reason,
        );
      }
      if (nextDecision === 'REPROCESS_REQUESTED') {
        if (current.version_content_revision !== current.content_revision) {
          throw new ApplicationError(
            'VERSION_CONFLICT',
            409,
            '当前文档已经产生更新修订，不能从旧报告再次发起重处理',
          );
        }
        reprocessJobId = await this.createReprocessRevision(
          client,
          current.document_id,
          current.document_version_id,
          current.content_revision + 1,
          command.reason,
        );
      }

      await client.query(
        `INSERT INTO knowledge_quality_reviews (
           report_id, action, previous_decision, resulting_decision, reason,
           actor_user_id, actor_roles, expected_version, resulting_version,
           request_id, trace_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          current.id,
          command.action,
          current.review_decision,
          nextDecision,
          command.reason,
          command.context.user.userId,
          [...command.context.user.roles],
          command.expectedVersion,
          report.optimistic_version,
          command.context.requestId,
          command.context.traceId ?? null,
        ],
      );
      await client.query(
        `INSERT INTO audit_logs (
           actor_user_id, actor_roles, authz_version, action, resource_type,
           resource_id, result, reason, metadata, request_id, trace_id
         ) VALUES ($1,$2,$3,'QUALITY_REVIEW','KNOWLEDGE_RUN',$4,'SUCCESS',left($5,300),
                   $6::jsonb,$7,$8)`,
        [
          command.context.user.userId,
          [...command.context.user.roles],
          command.context.user.authzVersion,
          command.processingRunId,
          command.reason,
          JSON.stringify({
            action: command.action,
            resultingDecision: nextDecision,
            reportVersion: report.optimistic_version,
            reprocessCreated: reprocessJobId !== null,
          }),
          command.context.requestId,
          command.context.traceId ?? null,
        ],
      );
      await client.query('COMMIT');
      return { report: mapReport(report), reprocessJobId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async finishAutomaticDecision(
    client: PoolClient,
    command: CompleteKnowledgeProcessingCommand,
  ): Promise<void> {
    const parentCount = command.chunks.filter((item) => item.granularity === 'PARENT').length;
    const childCount = command.chunks.length - parentCount;
    const status =
      command.quality.verdict === 'PASS'
        ? 'SUCCEEDED'
        : command.quality.verdict === 'MANUAL_REVIEW'
          ? 'WAITING'
          : 'REJECTED';
    await client.query(
      `UPDATE knowledge_processing_runs
          SET status = $2, parent_chunk_count = $3, child_chunk_count = $4,
              relation_count = $5, metrics = $6::jsonb, completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [
        command.processingRunId,
        status,
        parentCount,
        childCount,
        command.relations.length,
        JSON.stringify({ durationMs: command.durationMs, qualityVerdict: command.quality.verdict }),
      ],
    );
    await client.query(
      `UPDATE ingestion_job_steps
          SET status = 'SUCCEEDED', processed_units = COALESCE(total_units, 1),
              total_units = COALESCE(total_units, 1), stage_percent = 100,
              overall_percent = 65, public_message = 'Chunk 已生成',
              finished_at = COALESCE(finished_at, now()), updated_at = now()
        WHERE job_id = $1 AND step_name = 'CHUNK'`,
      [command.jobId],
    );
    if (command.quality.verdict === 'PASS') {
      await client.query(
        `UPDATE ingestion_job_steps
            SET status = 'SUCCEEDED', processed_units = 1, total_units = 1,
                stage_percent = 100, overall_percent = 75,
                public_message = '质量门禁自动通过', finished_at = now(), updated_at = now()
          WHERE job_id = $1 AND step_name = 'QUALITY_GATE'`,
        [command.jobId],
      );
      await client.query(
        `UPDATE ingestion_job_steps SET status = 'WAITING', overall_percent = 75,
                public_message = '等待 M05 向量化与索引', updated_at = now()
          WHERE job_id = $1 AND step_name = 'EMBED'`,
        [command.jobId],
      );
      await this.releaseJob(
        client,
        command.jobId,
        command.workerId,
        'WAITING',
        'EMBED',
        75,
        'M04 质量门禁通过，等待 M05',
      );
    } else if (command.quality.verdict === 'MANUAL_REVIEW') {
      await client.query(
        `UPDATE ingestion_job_steps SET status = 'WAITING', overall_percent = 65,
                public_message = '等待内容审核者复核', finished_at = NULL, updated_at = now()
          WHERE job_id = $1 AND step_name = 'QUALITY_GATE'`,
        [command.jobId],
      );
      await this.releaseJob(
        client,
        command.jobId,
        command.workerId,
        'WAITING',
        'QUALITY_GATE',
        65,
        '质量门禁需要人工审核',
      );
    } else {
      await client.query(
        `UPDATE ingestion_job_steps SET status = 'REJECTED', overall_percent = 65,
                public_message = '质量门禁拒绝', finished_at = now(), updated_at = now()
          WHERE job_id = $1 AND step_name = 'QUALITY_GATE'`,
        [command.jobId],
      );
      await this.releaseJob(
        client,
        command.jobId,
        command.workerId,
        'REJECTED',
        'QUALITY_GATE',
        65,
        '质量门禁拒绝，等待审核或重处理',
      );
    }
    await this.insertEvent(client, command.jobId, 'ingestion.m04_completed', {
      processingRunId: command.processingRunId,
      verdict: command.quality.verdict,
      parentChunkCount: parentCount,
      childChunkCount: childCount,
    });
  }

  private async releaseJob(
    client: PoolClient,
    jobId: string,
    workerId: string,
    status: 'WAITING' | 'REJECTED',
    currentStep: 'QUALITY_GATE' | 'EMBED',
    overallPercent: number,
    publicMessage: string,
  ): Promise<void> {
    await client.query(
      `UPDATE ingestion_jobs
          SET status = $3, current_step = $4, overall_percent = $5, public_message = $6,
              lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND lease_owner = $2`,
      [jobId, workerId, status, currentStep, overallPercent, publicMessage],
    );
    await client.query(
      `UPDATE document_versions SET status = $2, updated_at = now()
        WHERE id = (SELECT document_version_id FROM ingestion_jobs WHERE id = $1)`,
      [jobId, status],
    );
  }

  private async finishApprovedReview(
    client: PoolClient,
    jobId: string,
    processingRunId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE knowledge_processing_runs SET status = 'SUCCEEDED', updated_at = now() WHERE id = $1`,
      [processingRunId],
    );
    await client.query(
      `UPDATE ingestion_job_steps SET status = 'SUCCEEDED', processed_units = 1, total_units = 1,
              stage_percent = 100, overall_percent = 75, public_message = '人工审核通过',
              finished_at = now(), updated_at = now()
        WHERE job_id = $1 AND step_name = 'QUALITY_GATE'`,
      [jobId],
    );
    await client.query(
      `UPDATE ingestion_job_steps SET status = 'WAITING', overall_percent = 75,
              public_message = '等待 M05 向量化与索引', updated_at = now()
        WHERE job_id = $1 AND step_name = 'EMBED'`,
      [jobId],
    );
    await client.query(
      `UPDATE ingestion_jobs SET status = 'WAITING', current_step = 'EMBED', overall_percent = 75,
              public_message = '人工审核通过，等待 M05', updated_at = now()
        WHERE id = $1`,
      [jobId],
    );
    await client.query(
      `UPDATE document_versions SET status = 'WAITING', optimistic_version = optimistic_version + 1,
              updated_at = now()
        WHERE id = (SELECT document_version_id FROM ingestion_jobs WHERE id = $1)`,
      [jobId],
    );
    await this.insertEvent(client, jobId, 'ingestion.quality_approved', { processingRunId });
  }

  private async finishRejectedReview(
    client: PoolClient,
    jobId: string,
    processingRunId: string,
    reason: string,
  ): Promise<void> {
    await client.query(
      `UPDATE knowledge_processing_runs SET status = 'REJECTED', updated_at = now() WHERE id = $1`,
      [processingRunId],
    );
    await client.query(
      `UPDATE ingestion_job_steps SET status = 'REJECTED', public_message = '人工审核拒绝',
              finished_at = now(), updated_at = now()
        WHERE job_id = $1 AND step_name = 'QUALITY_GATE'`,
      [jobId],
    );
    await client.query(
      `UPDATE ingestion_jobs SET status = 'REJECTED', current_step = 'QUALITY_GATE',
              public_message = '人工审核拒绝', updated_at = now() WHERE id = $1`,
      [jobId],
    );
    await client.query(
      `UPDATE document_versions SET status = 'REJECTED', optimistic_version = optimistic_version + 1,
              updated_at = now()
        WHERE id = (SELECT document_version_id FROM ingestion_jobs WHERE id = $1)`,
      [jobId],
    );
    await this.insertEvent(client, jobId, 'ingestion.quality_rejected', {
      processingRunId,
      reasonRecorded: reason.length > 0,
    });
  }

  private async createReprocessRevision(
    client: PoolClient,
    documentId: string,
    documentVersionId: string,
    contentRevision: number,
    reason: string,
  ): Promise<string> {
    const pipelineVersion = 1;
    const jobId = createIngestionJobId(documentVersionId, contentRevision, pipelineVersion);
    await client.query(
      `UPDATE document_versions
          SET content_revision = $2, status = 'QUEUED', optimistic_version = optimistic_version + 1,
              updated_at = now() WHERE id = $1`,
      [documentVersionId, contentRevision],
    );
    await client.query(
      `INSERT INTO ingestion_jobs (
         id, document_id, document_version_id, content_revision, pipeline_version,
         status, current_step, public_message
       ) VALUES ($1,$2,$3,$4,$5,'QUEUED','SECURITY_SCAN','审核要求重处理')`,
      [jobId, documentId, documentVersionId, contentRevision, pipelineVersion],
    );
    for (const [index, step] of INGESTION_STEP_ORDER.entries()) {
      await client.query(
        `INSERT INTO ingestion_job_steps (
           id, job_id, step_name, step_version, position, status, weight_percent,
           processed_units, total_units, stage_percent, overall_percent, public_message
         ) VALUES ($1,$2,$3,1,$4,'QUEUED',$5,0,NULL,NULL,0,$6)`,
        [
          createIngestionStepId(documentVersionId, contentRevision, step, 1),
          jobId,
          step,
          index + 1,
          INGESTION_STEP_WEIGHTS[step],
          index === 0 ? '审核要求重处理' : '等待前置步骤',
        ],
      );
    }
    const payload = {
      jobId,
      documentId,
      documentVersionId,
      contentRevision,
      pipelineVersion,
      reason,
    };
    await this.insertEvent(client, jobId, 'ingestion.queued', payload);
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('INGESTION_JOB',$1,'ingestion.requested',$2::jsonb)`,
      [jobId, JSON.stringify(payload)],
    );
    return jobId;
  }

  private async assertLease(
    client: PoolClient,
    jobId: string,
    workerId?: string,
    currentStep?: 'CHUNK' | 'QUALITY_GATE',
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM ingestion_jobs
        WHERE id = $1 AND status = 'RUNNING'
          AND ($2::text IS NULL OR lease_owner = $2)
          AND lease_expires_at > now()
          AND ($3::text IS NULL OR current_step::text = $3::text)
        FOR UPDATE`,
      [jobId, workerId ?? null, currentStep ?? null],
    );
    if (result.rowCount !== 1) {
      throw new ApplicationError('INVALID_STATE', 409, 'Worker 租约已失效，禁止提交知识加工结果');
    }
  }

  private async assertVersionAccess(
    context: AccessContext,
    documentVersionId: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM document_versions dv
         JOIN documents d ON d.id = dv.document_id
        WHERE dv.id = $1 AND (
          $2::boolean OR EXISTS (
            SELECT 1 FROM resource_acl acl
             WHERE acl.resource_id = d.space_id
               AND ((acl.subject_type = 'USER' AND acl.subject_id = $3)
                 OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($4::text[])))
               AND acl.permissions && ARRAY['READ','WRITE','REVIEW','ADMIN']::text[]
          )
        )`,
      [
        documentVersionId,
        context.user.roles.includes('SYSTEM_ADMIN'),
        context.user.userId,
        [...context.user.roles],
      ],
    );
    if (result.rowCount !== 1) throw new ApplicationError('NOT_FOUND', 404, '文档版本不存在');
  }

  private async assertReviewPermission(
    client: PoolClient,
    context: AccessContext,
    spaceId: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM knowledge_spaces ks
        WHERE ks.id = $1 AND (
          $2::boolean OR EXISTS (
            SELECT 1 FROM resource_acl acl
             WHERE acl.resource_id = ks.id
               AND ((acl.subject_type = 'USER' AND acl.subject_id = $3)
                 OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($4::text[])))
               AND acl.permissions && ARRAY['REVIEW','ADMIN']::text[]
          )
        )`,
      [
        spaceId,
        context.user.roles.includes('SYSTEM_ADMIN'),
        context.user.userId,
        [...context.user.roles],
      ],
    );
    if (result.rowCount !== 1) {
      throw new ApplicationError('ACCESS_DENIED', 403, '无权审核该知识内容');
    }
  }

  private async insertEvent(
    client: PoolClient,
    jobId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ingestion_job_events (job_id, event_type, data) VALUES ($1,$2,$3::jsonb)`,
      [jobId, eventType, JSON.stringify(data)],
    );
  }
}

function mapRun(row: ProcessingRunRow): KnowledgeProcessingRun {
  return KnowledgeProcessingRunSchema.parse({
    id: row.id,
    jobId: row.job_id,
    parseRunId: row.parse_run_id,
    documentVersionId: row.document_version_id,
    contentRevision: row.content_revision,
    fileFormat: row.file_format,
    status: row.status,
    chunkerProfileId: row.chunker_profile_id,
    chunkerRevision: row.chunker_revision,
    tokenizerProfileId: row.tokenizer_profile_id,
    tokenizerRevision: row.tokenizer_revision,
    qualityRuleVersion: row.quality_rule_version,
    parentChunkCount: row.parent_chunk_count,
    childChunkCount: row.child_chunk_count,
    relationCount: row.relation_count,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    metrics: row.metrics,
    startedAt: iso(row.started_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapBlock(row: BlockRow): DocumentBlock {
  return DocumentBlockSchema.parse({
    id: row.id,
    parseRunId: row.parse_run_id,
    documentVersionId: row.document_version_id,
    contentRevision: row.content_revision,
    ordinal: row.ordinal,
    type: row.block_type,
    text: row.text_content,
    originalText: row.original_text,
    pageNo: row.page_no,
    sheetName: row.sheet_name,
    slideNo: row.slide_no,
    bbox: row.bbox,
    headingLevel: row.heading_level,
    parentBlockId: row.parent_block_id,
    confidence: row.confidence === null ? null : Number(row.confidence),
    table: row.table_data,
    parserName: row.parser_name,
    parserRevision: row.parser_revision,
    ocrEngine: row.ocr_engine,
    ocrRevision: row.ocr_revision,
    metadata: row.metadata,
    contentSha256: row.content_sha256,
    createdAt: iso(row.created_at),
  });
}

function mapChunk(row: ChunkRow): KnowledgeChunk {
  return KnowledgeChunkSchema.parse({
    id: row.id,
    processingRunId: row.processing_run_id,
    documentVersionId: row.document_version_id,
    contentRevision: row.content_revision,
    ordinal: row.ordinal,
    granularity: row.granularity,
    contentType: row.content_type,
    displayContent: row.display_content,
    embeddingText: row.embedding_text,
    tokenCount: row.token_count,
    tokenizerProfileId: row.tokenizer_profile_id,
    tokenizerRevision: row.tokenizer_revision,
    headingPath: row.heading_path,
    sourceLocations: row.source_locations,
    parentChunkId: row.parent_chunk_id,
    contentSha256: row.content_sha256,
    dedupStatus: row.dedup_status,
    duplicateOfChunkId: row.duplicate_of_chunk_id,
    eligibleForIndex: row.eligible_for_index,
    splitReason: row.split_reason,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
  });
}

function mapReport(row: ReportRow): DocumentQualityReport {
  return DocumentQualityReportSchema.parse({
    id: row.id,
    processingRunId: row.processing_run_id,
    documentVersionId: row.document_version_id,
    contentRevision: row.content_revision,
    verdict: row.verdict,
    ruleVersion: row.rule_version,
    metrics: row.metrics,
    reviewDecision: row.review_decision,
    reviewReason: row.review_reason,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at ? iso(row.reviewed_at) : null,
    optimisticVersion: row.optimistic_version,
    eligibleForIndex: row.eligible_for_index,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapFinding(row: FindingRow): QualityFinding {
  return QualityFindingSchema.parse({
    id: row.id,
    reportId: row.report_id,
    severity: row.severity,
    code: row.code,
    message: row.message,
    pageNos: row.page_nos,
    blockIds: row.block_ids,
    chunkIds: row.chunk_ids,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
  });
}

function requireRow<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
