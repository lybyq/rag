/**
 * M05 向量化、索引、对账和原子发布编排用例。
 *
 * 该服务把 M04 合格 Child Chunk 转成可发布向量，但不直接访问 PG、HTTP 或 Milvus SDK。
 * 关键顺序固定为：锁定快照 → 复用/生成 Embedding → 写不可见 Manifest → 对账 → PG 原子发布。
 * 当前有效 Manifest 只会在最后一个 PG 事务中切换，任何前序失败都不会影响线上检索。
 *
 * @requirement IDX-001
 * @requirement IDX-003
 * @requirement IDX-004
 * @requirement IDX-005
 * @requirement IDX-009
 * @requirement IDX-010
 * @requirement IDX-011
 * @requirement IDX-013
 * @requirement IDX-014
 */
import { createHash } from 'node:crypto';
import type {
  EmbeddingInput,
  EmbeddingOutput,
  EmbeddingProfile,
  EmbeddingProviderMetadata,
} from '@rag/contracts';
import { executeEmbeddingBatches, reconcileManifestRecords } from '@rag/retrieval';
import type {
  EmbeddingFact,
  EmbeddingPort,
  IndexBuildInput,
  IndexVectorRecord,
  IndexingRepository,
  ProviderCallOptions,
  VectorIndexPort,
} from './indexing.ports';

/** M05 有限资源和重试配置；进程启动后不可热变更。 */
export interface IndexingServiceConfig {
  readonly profile: EmbeddingProfile;
  readonly requestTimeoutMs: number;
  readonly overallDeadlineMs: number;
  readonly maxBatchTokens: number;
  readonly maxConcurrency: number;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly maxQueuedItems: number;
  readonly vectorWriteBatchSize: number;
  readonly vectorWriteMaxAttempts: number;
}

/** Worker 可观测的稳定处理结果。 */
export type IndexingOutcome = 'PUBLISHED' | 'STAGED' | 'NOT_CLAIMABLE' | 'FAILED';

/** Provider 元数据不兼容时使用的稳定错误，消息不包含 Endpoint 或密钥。 */
export class EmbeddingProfileMismatchError extends Error {
  public constructor(public readonly fields: readonly string[]) {
    super(`Embedding Provider 元数据与 Profile 不兼容：${fields.join(', ')}`);
    this.name = 'EmbeddingProfileMismatchError';
  }
}

/** M05 单任务编排服务。 */
export class IndexingService {
  private compatibilityCheck: Promise<void> | undefined;

  public constructor(
    private readonly repository: IndexingRepository,
    private readonly embedding: EmbeddingPort,
    private readonly vectorIndex: VectorIndexPort,
    private readonly config: IndexingServiceConfig,
  ) {}

  /**
   * 启动或首次执行时真实访问 `/health` 和 `/metadata`。
   * Promise 会被同进程并发 Run 复用；失败不缓存，恢复后下一次可重新检查。
   */
  public async verifyProviderCompatibility(signal = new AbortController().signal): Promise<void> {
    this.compatibilityCheck ??= this.performCompatibilityCheck(signal).catch((error) => {
      this.compatibilityCheck = undefined;
      throw error;
    });
    return this.compatibilityCheck;
  }

  /** 执行完整 M05 流水线；异常会安全落为 WAITING/FAILED，不切换当前线上 Manifest。 */
  public async process(
    jobId: string,
    workerId: string,
    parentSignal = new AbortController().signal,
  ): Promise<IndexingOutcome> {
    const deadlineAt = new Date(Date.now() + this.config.overallDeadlineMs);
    const controller = linkDeadline(parentSignal, deadlineAt);
    let input: IndexBuildInput | undefined;
    try {
      await this.verifyProviderCompatibility(controller.signal);
      const registry = await this.repository.resolveProfileCollection(this.config.profile);
      input = await this.repository.beginRun({
        jobId,
        workerId,
        profile: this.config.profile,
        collectionName: registry.collectionName,
        aliasName: registry.aliasName,
      });
      if (!input) return 'NOT_CLAIMABLE';
      // 独立常量让异步回调共享同一个已判空的不可变 Run 快照。
      const build = input;

      await this.repository.startStep(
        jobId,
        workerId,
        'EMBED',
        0,
        build.chunks.length,
        '正在复用或生成 Embedding',
      );
      const resolvedFacts = await this.resolveEmbeddingFacts(build, deadlineAt, controller.signal);
      const facts = resolvedFacts.facts;
      const factByHash = new Map(facts.map((fact) => [fact.contentSha256, fact]));
      const references = build.chunks.map((chunk) => {
        const fact = factByHash.get(chunk.contentSha256);
        if (!fact) throw new Error(`Embedding 事实缺失：${chunk.chunkId}`);
        return { chunkId: chunk.chunkId, embeddingFactId: fact.id };
      });
      await this.repository.saveChunkEmbeddingReferences(
        build.run.id,
        references,
        resolvedFacts.embeddedCount,
        resolvedFacts.reusedCount,
      );

      await this.repository.startStep(
        jobId,
        workerId,
        'INDEX',
        0,
        build.chunks.length,
        '正在写入不可见索引构建区',
      );
      await this.vectorIndex.ensureProfileCollection(
        this.config.profile,
        build.run.collectionName,
        registry.aliasName,
        callOptions(deadlineAt, this.config.requestTimeoutMs, controller.signal),
      );
      const records = build.chunks.map((chunk) =>
        toVectorRecord(build, chunk, requireFact(factByHash, chunk.contentSha256)),
      );
      await this.writeVectorsWithRetry(
        build.run.collectionName,
        records,
        deadlineAt,
        controller.signal,
      );
      await this.repository.markIndexed(build.run.id, records.length);

      await this.repository.startStep(
        jobId,
        workerId,
        'VERIFY',
        records.length,
        records.length,
        '正在对账主键、Hash、Profile 和固定查询',
      );
      const actual = await this.vectorIndex.listManifestRecordFacts(
        build.run.collectionName,
        build.manifest.id,
        callOptions(deadlineAt, this.config.requestTimeoutMs, controller.signal),
      );
      const fixedIds = chooseFixedIds(records);
      const returnedIds = await this.vectorIndex.lookupRecordIds(
        build.run.collectionName,
        build.manifest.id,
        fixedIds,
        callOptions(deadlineAt, this.config.requestTimeoutMs, controller.signal),
      );
      const report = reconcileManifestRecords({
        manifestId: build.manifest.id,
        embeddingProfileId: this.config.profile.profileId,
        expected: records.map((record) => ({
          vectorId: record.vectorId,
          contentSha256: record.contentSha256,
        })),
        actual,
        fixedQueryExpectedIds: fixedIds,
        fixedQueryReturnedIds: returnedIds,
      });
      if (!report.passed) throw new Error('索引对账未通过，禁止发布');
      await this.repository.markVerified(build.run.id, report);

      await this.repository.startStep(
        jobId,
        workerId,
        'PUBLISH',
        0,
        1,
        '正在原子切换空间 Manifest',
      );
      if (build.rollout) {
        // Profile rollout 必须先离线评测。这里仅封存 VERIFIED 候选并释放入库 Job，
        // 不触碰稳定 Head；Scheduler 评测通过后才进入 CANARY 或 FULL 发布。
        await this.repository.stageProfileCandidate(
          build.run.id,
          jobId,
          workerId,
          build.rollout.requestId,
        );
        return 'STAGED';
      }
      // Repository 只在 PG 事务成功后创建延迟清理任务。保留期内旧 Manifest 可直接回滚，
      // Scheduler 的清理失败也只会产生告警，不会反向破坏已经发布的新版本。
      await this.repository.publish(build.run.id, jobId, workerId);
      return 'PUBLISHED';
    } catch (error) {
      await this.repository.fail(
        input?.run.id ?? null,
        jobId,
        workerId,
        classifyIndexingFailure(error),
        publicErrorMessage(error),
      );
      return 'FAILED';
    } finally {
      controller.abort();
    }
  }

  private async performCompatibilityCheck(signal: AbortSignal): Promise<void> {
    const deadlineAt = new Date(Date.now() + this.config.requestTimeoutMs * 2);
    await this.embedding.checkHealth(callOptions(deadlineAt, this.config.requestTimeoutMs, signal));
    const actual = await this.embedding.getMetadata(
      callOptions(deadlineAt, this.config.requestTimeoutMs, signal),
    );
    assertProviderCompatible(this.config.profile, actual);
  }

  private async resolveEmbeddingFacts(
    input: IndexBuildInput,
    deadlineAt: Date,
    signal: AbortSignal,
  ): Promise<{
    readonly facts: readonly EmbeddingFact[];
    readonly embeddedCount: number;
    readonly reusedCount: number;
  }> {
    const representativeByHash = new Map<string, IndexBuildInput['chunks'][number]>();
    for (const chunk of input.chunks) {
      if (!representativeByHash.has(chunk.contentSha256)) {
        representativeByHash.set(chunk.contentSha256, chunk);
      }
    }
    const hashes = [...representativeByHash.keys()];
    const cached = await this.repository.findEmbeddingFacts(this.config.profile.profileId, hashes);
    const cachedHashes = new Set(cached.map((fact) => fact.contentSha256));
    const missing: EmbeddingInput[] = [...representativeByHash.values()]
      .filter((chunk) => !cachedHashes.has(chunk.contentSha256))
      .map((chunk) => ({
        itemId: chunk.chunkId,
        contentSha256: chunk.contentSha256,
        text: chunk.embeddingText,
        tokenCount: chunk.tokenCount,
      }));
    if (missing.length === 0) {
      return { facts: cached, embeddedCount: 0, reusedCount: cached.length };
    }

    const result = await executeEmbeddingBatches(
      missing,
      (batch) =>
        this.embedding.embedDocuments(
          batch,
          callOptions(deadlineAt, this.config.requestTimeoutMs, signal),
        ),
      {
        maxBatchItems: Math.min(this.config.profile.maxBatchSize, missing.length),
        maxBatchTokens: this.config.maxBatchTokens,
        maxConcurrency: this.config.maxConcurrency,
        maxAttempts: this.config.maxAttempts,
        retryBaseDelayMs: this.config.retryBaseDelayMs,
        maxQueuedItems: this.config.maxQueuedItems,
        signal,
      },
    );
    if (result.failures.length > 0) {
      throw new Error(`Embedding 有 ${result.failures.length} 项失败`);
    }
    for (const output of result.outputs) validateEmbeddingOutput(this.config.profile, output);
    const saved = await this.repository.saveEmbeddingFacts(this.config.profile, result.outputs);
    return {
      facts: [...cached, ...saved],
      embeddedCount: saved.length,
      reusedCount: cached.length,
    };
  }

  private async writeVectorsWithRetry(
    collectionName: string,
    records: readonly IndexVectorRecord[],
    deadlineAt: Date,
    signal: AbortSignal,
  ): Promise<void> {
    for (let offset = 0; offset < records.length; offset += this.config.vectorWriteBatchSize) {
      let pending = records.slice(offset, offset + this.config.vectorWriteBatchSize);
      for (let attempt = 1; attempt <= this.config.vectorWriteMaxAttempts; attempt += 1) {
        if (pending.length === 0) break;
        const result = await this.vectorIndex.upsertManifestRecords(
          collectionName,
          pending,
          callOptions(deadlineAt, this.config.requestTimeoutMs, signal),
        );
        if (result.terminalVectorIds.length > 0) {
          throw new Error(`Milvus 有 ${result.terminalVectorIds.length} 条不可重试写入失败`);
        }
        const retryable = new Set(result.retryableVectorIds);
        pending = pending.filter((record) => retryable.has(record.vectorId));
      }
      if (pending.length > 0) throw new Error(`Milvus 写入重试耗尽：${pending.length} 条`);
    }
  }
}

/** 精确比对所有会影响 Collection 兼容性与历史复现的字段。 */
export function assertProviderCompatible(
  profile: EmbeddingProfile,
  metadata: EmbeddingProviderMetadata,
): void {
  const mismatches: string[] = [];
  if (profile.modelId !== metadata.modelId) mismatches.push('modelId');
  if (profile.revision !== metadata.revision) mismatches.push('revision');
  if (profile.protocolVersion !== metadata.protocolVersion) mismatches.push('protocolVersion');
  if (profile.tokenizerRevision !== metadata.tokenizerRevision)
    mismatches.push('tokenizerRevision');
  if (profile.denseDimension !== metadata.denseDimension) mismatches.push('denseDimension');
  if (profile.normalizeDense !== metadata.normalizeDense) mismatches.push('normalizeDense');
  if (profile.sparseFormatVersion !== metadata.sparseFormatVersion)
    mismatches.push('sparseFormatVersion');
  if (profile.maxInputTokens > metadata.maxInputTokens) mismatches.push('maxInputTokens');
  for (const capability of ['query', 'document', 'dense'] as const) {
    if (!metadata.capabilities.includes(capability)) mismatches.push(`capability:${capability}`);
  }
  if (profile.sparseFormatVersion && !metadata.capabilities.includes('sparse')) {
    mismatches.push('capability:sparse');
  }
  if (mismatches.length > 0) throw new EmbeddingProfileMismatchError(mismatches);
}

function validateEmbeddingOutput(profile: EmbeddingProfile, output: EmbeddingOutput): void {
  if (output.modelId !== profile.modelId || output.revision !== profile.revision) {
    throw new EmbeddingProfileMismatchError(['response.model']);
  }
  if (output.dense.length !== profile.denseDimension) {
    throw new EmbeddingProfileMismatchError(['response.denseDimension']);
  }
  if (profile.sparseFormatVersion !== null && output.sparse === null) {
    throw new EmbeddingProfileMismatchError(['response.sparse']);
  }
  if (profile.normalizeDense) {
    const norm = Math.sqrt(output.dense.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.02) {
      throw new EmbeddingProfileMismatchError(['response.normalization']);
    }
  }
}

function toVectorRecord(
  input: IndexBuildInput,
  chunk: IndexBuildInput['chunks'][number],
  fact: EmbeddingFact,
): IndexVectorRecord {
  return {
    vectorId: createHash('sha256')
      .update(`${input.manifest.id}:${chunk.chunkId}:${input.run.embeddingProfileId}`)
      .digest('hex'),
    manifestId: input.manifest.id,
    spaceId: input.run.spaceId,
    documentId: chunk.documentId,
    documentVersionId: chunk.documentVersionId,
    contentRevision: chunk.contentRevision,
    chunkId: chunk.chunkId,
    ordinal: chunk.ordinal,
    contentSha256: chunk.contentSha256,
    embeddingProfileId: input.run.embeddingProfileId,
    shortSummary: chunk.displayContent.replace(/\s+/g, ' ').trim().slice(0, 500),
    headingPath: chunk.headingPath,
    sourceLocations: chunk.sourceLocations,
    dense: fact.dense,
    sparse: fact.sparse,
  };
}

function requireFact(
  facts: ReadonlyMap<string, EmbeddingFact>,
  contentSha256: string,
): EmbeddingFact {
  const fact = facts.get(contentSha256);
  if (!fact) throw new Error('Embedding 事实不完整');
  return fact;
}

function chooseFixedIds(records: readonly IndexVectorRecord[]): readonly string[] {
  if (records.length <= 3) return records.map((record) => record.vectorId);
  const middle = records[Math.floor(records.length / 2)];
  return [records[0]?.vectorId, middle?.vectorId, records.at(-1)?.vectorId].filter(
    (value): value is string => Boolean(value),
  );
}

function callOptions(
  deadlineAt: Date,
  configuredTimeoutMs: number,
  signal: AbortSignal,
): ProviderCallOptions {
  const remaining = deadlineAt.getTime() - Date.now();
  if (remaining <= 0) throw new Error('M05 整体 Deadline 已到期');
  return { signal, deadlineAt, timeoutMs: Math.min(configuredTimeoutMs, remaining) };
}

function linkDeadline(parent: AbortSignal, deadlineAt: Date): AbortController {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('M05 整体 Deadline 已到期')),
    Math.max(1, deadlineAt.getTime() - Date.now()),
  );
  timer.unref();
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller;
}

function classifyIndexingFailure(error: unknown): string {
  if (error instanceof EmbeddingProfileMismatchError) return 'EMBEDDING_PROFILE_MISMATCH';
  if (error instanceof Error && /对账/.test(error.message)) return 'INDEX_RECONCILIATION_FAILED';
  if (error instanceof Error && /Milvus/.test(error.message)) return 'VECTOR_STORE_FAILED';
  return 'INDEXING_FAILED';
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof EmbeddingProfileMismatchError) return error.message.slice(0, 500);
  if (error instanceof Error && /取消|Deadline|超时/.test(error.message))
    return 'M05 调用已取消或超时';
  if (error instanceof Error && /对账/.test(error.message))
    return '索引对账失败，当前线上版本保持不变';
  return '向量化或索引构建失败，当前线上版本保持不变';
}
