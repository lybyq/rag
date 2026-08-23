/**
 * 评测管理与后台执行应用服务。
 *
 * 管理服务负责权限、版本快照与基线操作；Worker 服务只处理数据库租约领取的 Case，
 * 每轮最多做一次有限动作，不在内存形成无界队列。所有评分由纯函数完成并持久化事实。
 *
 * @requirement OPS-001
 * @requirement OPS-002
 * @requirement OPS-003
 * @requirement OPS-004
 */
import type {
  CreateEvaluationDatasetRequest,
  CreateEvaluationRunRequest,
  EvaluationBaseline,
  EvaluationCase,
  EvaluationDataset,
  EvaluationRun,
  EvaluationRunDetail,
  PromoteEvaluationBaselineRequest,
} from '@rag/contracts';
import {
  aggregateEvaluationMetrics,
  compareEvaluationBaseline,
  scoreEvaluationCase,
} from '@rag/evaluation';
import { createHash } from 'node:crypto';
import { ApplicationError } from './application.error';
import type { AuthorizationService } from './authorization.service';
import type {
  ClaimedEvaluationCase,
  EvaluationQuestionRunnerPort,
  EvaluationRepository,
} from './evaluation.ports';
import type { AccessContext } from './ports';

/** 创建 Run 时锁定的当前配置。 */
export interface EvaluationServiceConfig {
  readonly flowVersion: string;
  readonly policyVersion: string;
  readonly promptProfileId: string;
  readonly embeddingProfileId: string;
  readonly embeddingRevision: string;
  readonly rerankerProfileId: string;
  readonly rerankerRevision: string;
  readonly llmProfileId: string;
  readonly llmRevision: string;
  readonly validatorProfileId: string;
}

/** 面向管理员 API 的评测服务。 */
export class EvaluationService {
  public constructor(
    private readonly repository: EvaluationRepository,
    private readonly config: EvaluationServiceConfig,
    private readonly authorization: AuthorizationService,
  ) {}

  /** 创建不可与同名版本冲突的数据集；只允许知识或系统管理员。 */
  public async createDataset(
    context: AccessContext,
    request: CreateEvaluationDatasetRequest,
  ): Promise<EvaluationDataset> {
    assertEvaluationOperator(context);
    const requestedSpaceIds = [
      ...new Set(request.cases.flatMap((item) => item.requestedSpaceIds ?? [])),
    ].sort();
    if (requestedSpaceIds.length > 0) {
      const allowed = await this.authorization.restrictRequestedSpaces(context, requestedSpaceIds);
      if (allowed.length !== requestedSpaceIds.length) {
        throw new ApplicationError('ACCESS_DENIED', 403, '评测集包含当前身份不可读的知识空间');
      }
    }
    return this.repository.createDataset(context, {
      ...request,
      createdBy: context.user.userId,
      creatorRoles: context.user.roles,
      creatorAuthzVersion: context.user.authzVersion,
    });
  }

  /** 激活后版本不可原地修改。 */
  public activateDataset(context: AccessContext, datasetId: string): Promise<EvaluationDataset> {
    assertEvaluationOperator(context);
    return this.repository.activateDataset(context, datasetId);
  }

  /** 读取已授权的评测集。 */
  public listDatasets(context: AccessContext): Promise<readonly EvaluationDataset[]> {
    assertEvaluationReader(context);
    return this.repository.listDatasets(context);
  }

  /** 读取评测集和 Case。 */
  public async getDataset(
    context: AccessContext,
    datasetId: string,
  ): Promise<{ readonly dataset: EvaluationDataset; readonly cases: readonly EvaluationCase[] }> {
    assertEvaluationReader(context);
    const [dataset, cases] = await Promise.all([
      this.repository.getDataset(context, datasetId),
      this.repository.listCases(context, datasetId),
    ]);
    return { dataset, cases };
  }

  /** 创建异步运行并锁定全部影响结果的版本事实。 */
  public async createRun(
    context: AccessContext,
    request: CreateEvaluationRunRequest,
  ): Promise<EvaluationRun> {
    assertEvaluationOperator(context);
    const manifestIds = await this.repository.resolveManifestIds(context, request.datasetId);
    return this.repository.createRun(context, {
      datasetId: request.datasetId,
      ...(request.baselineId ? { baselineId: request.baselineId } : {}),
      ...(request.note ? { note: request.note } : {}),
      createdBy: context.user.userId,
      creatorRoles: context.user.roles,
      creatorAuthzVersion: context.user.authzVersion,
      snapshot: {
        ...this.config,
        manifestIds: [...manifestIds],
        codeVersion: request.codeVersion ?? 'working-tree',
      },
    });
  }

  /** 列出最近运行。 */
  public listRuns(context: AccessContext): Promise<readonly EvaluationRun[]> {
    assertEvaluationReader(context);
    return this.repository.listRuns(context);
  }

  /** 读取指标、基线差异与失败样本。 */
  public getRun(context: AccessContext, runId: string): Promise<EvaluationRunDetail> {
    assertEvaluationReader(context);
    return this.repository.getRunDetail(context, runId);
  }

  /** 只有完成且门禁通过的运行才能提升为不可变基线。 */
  public promoteBaseline(
    context: AccessContext,
    runId: string,
    request: PromoteEvaluationBaselineRequest,
  ): Promise<EvaluationBaseline> {
    assertEvaluationOperator(context);
    return this.repository.promoteBaseline(context, runId, request.name, request.reason);
  }
}

/** Worker 的有限批处理配置。 */
export interface EvaluationWorkerConfig {
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
  readonly pendingPollSeconds: number;
}

/** 后台 Case 执行与运行聚合服务。 */
export class EvaluationWorkerService {
  public constructor(
    private readonly repository: EvaluationRepository,
    private readonly runner: EvaluationQuestionRunnerPort,
    private readonly config: EvaluationWorkerConfig,
  ) {}

  /** 每次 Tick 只领取有限 Case，并允许不同实例用 SKIP LOCKED 并行。 */
  public async process(workerId: string): Promise<number> {
    const tasks = await this.repository.claimCases(
      workerId,
      this.config.batchSize,
      this.config.leaseSeconds,
    );
    for (const task of tasks) await this.processCase(task, workerId);
    const readyRuns = await this.repository.claimReadyRuns(
      workerId,
      this.config.batchSize,
      this.config.leaseSeconds,
    );
    for (const ready of readyRuns) {
      const caseScores = ready.scores.map((item) => ({
        scores: item.scores,
        failureCodes: [],
        passed: item.passed,
      }));
      const metrics = aggregateEvaluationMetrics(caseScores);
      const regressions = ready.baseline
        ? compareEvaluationBaseline(metrics, ready.baseline.metrics)
        : [];
      await this.repository.finalizeRun(ready.run.id, workerId, metrics, regressions);
    }
    return tasks.length + readyRuns.length;
  }

  private async processCase(task: ClaimedEvaluationCase, workerId: string): Promise<void> {
    const started = Date.now();
    try {
      if (task.fixtureActual) {
        await this.saveScore(task, workerId, task.fixtureActual, Date.now() - started);
        return;
      }
      if (!task.ragRunId) {
        const ragRunId = await this.runner.start(task);
        await this.repository.attachRagRun(task.resultId, workerId, ragRunId);
        return;
      }
      const result = await this.runner.read(task);
      if (result.status === 'PENDING') {
        await this.repository.releaseCase(task.resultId, workerId, this.config.pendingPollSeconds);
        return;
      }
      if (result.status === 'FAILED') {
        await this.repository.failCase(
          task.resultId,
          workerId,
          result.code,
          task.attempts >= this.config.maxAttempts,
        );
        return;
      }
      await this.saveScore(task, workerId, result.actual, result.durationMs);
    } catch {
      await this.repository.failCase(
        task.resultId,
        workerId,
        'EVALUATION_EXECUTION_FAILED',
        task.attempts >= this.config.maxAttempts,
      );
    }
  }

  private async saveScore(
    task: ClaimedEvaluationCase,
    workerId: string,
    actual: Parameters<typeof scoreEvaluationCase>[1],
    durationMs: number,
  ): Promise<void> {
    const result = scoreEvaluationCase(task.testCase, actual);
    await this.repository.completeCase(
      task.resultId,
      workerId,
      actual,
      result.scores,
      result.failureCodes,
      result.passed,
      durationMs,
    );
  }
}

/** 评测任务幂等键不包含原问题，避免它出现在日志与指标标签。 */
export function evaluationCaseIdempotencyKey(task: ClaimedEvaluationCase): string {
  return `eval:${createHash('sha256')
    .update(`${task.evaluationRunId}:${task.testCase.id}`)
    .digest('base64url')}`;
}

function assertEvaluationOperator(context: AccessContext): void {
  if (!context.user.roles.some((role) => role === 'SYSTEM_ADMIN' || role === 'KNOWLEDGE_ADMIN')) {
    throw new ApplicationError('ACCESS_DENIED', 403, '仅知识管理员或系统管理员可以修改评测');
  }
}

function assertEvaluationReader(context: AccessContext): void {
  if (
    !context.user.roles.some(
      (role) => role === 'SYSTEM_ADMIN' || role === 'KNOWLEDGE_ADMIN' || role === 'AUDITOR',
    )
  ) {
    throw new ApplicationError('ACCESS_DENIED', 403, '当前角色不能查看评测');
  }
}
