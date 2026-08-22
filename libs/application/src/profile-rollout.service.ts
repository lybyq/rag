/**
 * M05 新 Embedding Profile 的全量重建、离线评测与灰度编排。
 *
 * BUILD 只创建标准入库 Job；实际候选继续复用 M03→M05 主链路。
 * EVALUATE 使用 query 端点查询候选 Manifest，报告不保存问题正文，只保存命中布尔值摘要。
 * 本服务不直接访问 PG、BullMQ 或 Milvus SDK，所有外部系统仍通过 Port 调用。
 *
 * @requirement IDX-001
 * @requirement IDX-016
 */
import { createHash } from 'node:crypto';
import type { EmbeddingInput, EmbeddingProfile } from '@rag/contracts';
import { executeEmbeddingBatches } from '@rag/retrieval';
import { assertProviderCompatible } from './indexing.service';
import type {
  EmbeddingPort,
  ProfileRebuildTask,
  ProfileRolloutRepository,
  ProviderCallOptions,
  VectorIndexPort,
} from './indexing.ports';

/** rollout 的有限资源和质量门槛配置。 */
export interface ProfileRolloutConfig {
  readonly profile: EmbeddingProfile;
  readonly requestTimeoutMs: number;
  readonly overallDeadlineMs: number;
  readonly maxCases: number;
  readonly evaluationTopK: number;
  readonly minimumRecall: number;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
}

/** Scheduler 稳定结果，供固定 Prometheus 标签使用。 */
export type ProfileRolloutOutcome =
  | 'BUILD_ENQUEUED'
  | 'FULL_PUBLISHED'
  | 'CANARY_READY'
  | 'EVALUATION_FAILED'
  | 'RETRY'
  | 'MANUAL';

/** Profile rollout 应用服务。 */
export class ProfileRolloutService {
  public constructor(
    private readonly repository: ProfileRolloutRepository,
    private readonly embedding: EmbeddingPort,
    private readonly vectorIndex: VectorIndexPort,
    private readonly config: ProfileRolloutConfig,
  ) {}

  /** 处理一个带数据库 lease 的动作；错误最多有限重试，Profile 不匹配直接进入人工处理。 */
  public async process(
    task: ProfileRebuildTask,
    workerId: string,
    parentSignal = new AbortController().signal,
  ): Promise<ProfileRolloutOutcome> {
    const controller = linkedDeadline(parentSignal, this.config.overallDeadlineMs);
    try {
      if (task.embeddingProfileId !== this.config.profile.profileId) {
        throw new ProfileRolloutTerminalError('请求 Profile 与当前 Scheduler Profile 不一致');
      }
      if (task.action === 'BUILD') {
        await this.repository.prepareProfileRebuild(task.requestId, workerId, this.config.profile);
        return 'BUILD_ENQUEUED';
      }
      const reportPassed = await this.evaluateCandidate(task, workerId, controller.signal);
      if (!reportPassed) return 'EVALUATION_FAILED';
      return task.mode === 'CANARY' ? 'CANARY_READY' : 'FULL_PUBLISHED';
    } catch (error) {
      const terminal =
        error instanceof ProfileRolloutTerminalError || task.attempts >= this.config.maxAttempts;
      await this.repository.failProfileRebuild(
        task.requestId,
        workerId,
        error instanceof ProfileRolloutTerminalError ? 'PROFILE_MISMATCH' : 'ROLLOUT_FAILED',
        terminal ? 'Profile rollout 需要人工处理' : 'Profile rollout 暂时失败，将自动重试',
        Math.min(
          3_600,
          Math.max(
            1,
            Math.ceil((this.config.retryBaseDelayMs * 2 ** Math.max(0, task.attempts - 1)) / 1_000),
          ),
        ),
        terminal,
      );
      return terminal ? 'MANUAL' : 'RETRY';
    } finally {
      controller.abort();
    }
  }

  private async evaluateCandidate(
    task: ProfileRebuildTask,
    workerId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const deadlineAt = new Date(Date.now() + this.config.overallDeadlineMs);
    await this.embedding.checkHealth(options(deadlineAt, this.config.requestTimeoutMs, signal));
    const metadata = await this.embedding.getMetadata(
      options(deadlineAt, this.config.requestTimeoutMs, signal),
    );
    try {
      assertProviderCompatible(this.config.profile, metadata);
    } catch {
      throw new ProfileRolloutTerminalError('Embedding Provider 元数据不兼容');
    }
    const candidate = await this.repository.loadProfileCandidate(
      task.requestId,
      workerId,
      this.config.maxCases,
    );
    const inputs: EmbeddingInput[] = candidate.cases.map((item) => ({
      itemId: item.caseId,
      contentSha256: item.querySha256,
      text: item.queryText,
      tokenCount: item.tokenCount,
    }));
    const embeddings = await executeEmbeddingBatches(
      inputs,
      (batch) =>
        this.embedding.embedQueries(
          batch,
          options(deadlineAt, this.config.requestTimeoutMs, signal),
        ),
      {
        maxBatchItems: this.config.profile.maxBatchSize,
        maxBatchTokens: this.config.profile.maxInputTokens * this.config.profile.maxBatchSize,
        maxConcurrency: 2,
        maxAttempts: 2,
        retryBaseDelayMs: this.config.retryBaseDelayMs,
        maxQueuedItems: this.config.maxCases,
        signal,
      },
    );
    if (embeddings.failures.length > 0 || embeddings.outputs.length !== inputs.length) {
      throw new Error('Profile 离线评测 Query Embedding 不完整');
    }
    const expectedByCase = new Map(
      candidate.cases.map((item) => [item.caseId, item.expectedDocumentId]),
    );
    const caseFacts: { caseId: string; expectedDocumentId: string; hit: boolean }[] = [];
    for (const output of embeddings.outputs) {
      if (output.dense.length !== candidate.manifest.denseDimension) {
        throw new ProfileRolloutTerminalError('候选查询向量维度不匹配');
      }
      const expectedDocumentId = expectedByCase.get(output.itemId);
      if (!expectedDocumentId) throw new Error('Profile 离线评测关联项缺失');
      const hits = await this.vectorIndex.searchManifestDense(
        candidate.manifest.collectionName,
        candidate.manifest.id,
        output.dense,
        this.config.evaluationTopK,
        options(deadlineAt, this.config.requestTimeoutMs, signal),
      );
      caseFacts.push({
        caseId: output.itemId,
        expectedDocumentId,
        hit: hits.some((hit) => hit.documentId === expectedDocumentId),
      });
    }
    const passedCases = caseFacts.filter((item) => item.hit).length;
    const recall = caseFacts.length === 0 ? 0 : passedCases / caseFacts.length;
    const passed = recall >= this.config.minimumRecall;
    const report = {
      reportVersion: 'm05-profile-eval-v1',
      candidateManifestId: candidate.manifest.id,
      embeddingProfileId: candidate.manifest.embeddingProfileId,
      caseCount: caseFacts.length,
      passedCases,
      recall,
      minimumRecall: this.config.minimumRecall,
      topK: this.config.evaluationTopK,
      caseFactsSha256: createHash('sha256')
        .update(
          JSON.stringify(caseFacts.sort((left, right) => left.caseId.localeCompare(right.caseId))),
        )
        .digest('hex'),
    };
    await this.repository.completeProfileEvaluation(task.requestId, workerId, report, passed);
    return passed;
  }
}

class ProfileRolloutTerminalError extends Error {}

function options(
  deadlineAt: Date,
  configuredTimeoutMs: number,
  signal: AbortSignal,
): ProviderCallOptions {
  const remaining = deadlineAt.getTime() - Date.now();
  if (remaining <= 0) throw new Error('Profile rollout Deadline 已到期');
  return { signal, deadlineAt, timeoutMs: Math.min(configuredTimeoutMs, remaining) };
}

function linkedDeadline(parent: AbortSignal, milliseconds: number): AbortController {
  const controller = new AbortController();
  const fromParent = (): void => controller.abort(parent.reason);
  if (parent.aborted) fromParent();
  else parent.addEventListener('abort', fromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('Profile rollout Deadline 已到期')),
    milliseconds,
  );
  timer.unref();
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller;
}
