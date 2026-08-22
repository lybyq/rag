/**
 * M05 Embedding、向量索引、Manifest 发布与跨存储对账端口。
 *
 * Application 只能依赖这些接口；HTTP 协议、Milvus SDK、PG SQL 和 MinIO SDK 均由 Adapter 隔离。
 * 所有远程调用显式携带 Deadline 与 AbortSignal，业务文本不得进入错误或日志。
 *
 * @requirement IDX-001
 * @requirement IDX-005
 * @requirement IDX-006
 * @requirement IDX-011
 * @requirement IDX-015
 */
import type {
  EmbeddingBatchResponse,
  EmbeddingInput,
  EmbeddingOutput,
  EmbeddingProfile,
  EmbeddingProviderMetadata,
  IndexingRun,
  IndexReconciliationReport,
  ManifestDocumentMember,
  IndexRebuild,
  RollbackManifestRequest,
  SpaceManifest,
  SparseVector,
} from '@rag/contracts';
import type { AccessContext } from './ports';

/** 每次远程调用的双重时间边界；Adapter 应采用两者中更早者。 */
export interface ProviderCallOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly deadlineAt: Date;
}

/** Query 与 Document 使用独立方法，禁止调用者漏传 purpose。 */
export interface EmbeddingPort {
  checkHealth(options: ProviderCallOptions): Promise<void>;
  getMetadata(options: ProviderCallOptions): Promise<EmbeddingProviderMetadata>;
  embedDocuments(
    inputs: readonly EmbeddingInput[],
    options: ProviderCallOptions,
  ): Promise<EmbeddingBatchResponse>;
  embedQueries(
    inputs: readonly EmbeddingInput[],
    options: ProviderCallOptions,
  ): Promise<EmbeddingBatchResponse>;
}

/** Manifest 中需要向量化的来源 Chunk；正文只进入 Embedding，不进入 Milvus 元数据。 */
export interface IndexableChunk {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly ordinal: number;
  readonly embeddingText: string;
  readonly displayContent: string;
  readonly tokenCount: number;
  readonly contentSha256: string;
  readonly headingPath: readonly string[];
  readonly sourceLocations: readonly unknown[];
}

/** 以 contentHash + Profile 唯一的 Embedding 事实。 */
export interface EmbeddingFact {
  readonly id: string;
  readonly embeddingProfileId: string;
  readonly contentSha256: string;
  readonly dense: readonly number[];
  readonly sparse: SparseVector | null;
  readonly modelId: string;
  readonly modelRevision: string;
}

/** Worker 开始一次 M05 Run 后获得的不可变输入快照。 */
export interface IndexBuildInput {
  readonly run: IndexingRun;
  readonly manifest: SpaceManifest;
  readonly members: readonly ManifestDocumentMember[];
  readonly chunks: readonly IndexableChunk[];
  /** 存在时这是 Profile 候选构建，对账后只进入评测，禁止普通自动发布。 */
  readonly rollout?: ProfileRolloutContext;
}

/** Profile 重建与普通文档发布的分流事实。 */
export interface ProfileRolloutContext {
  readonly requestId: string;
  readonly mode: 'FULL' | 'CANARY';
  readonly canaryPercent: number;
}

/** Milvus 只保存短摘要、检索过滤字段与向量；不保存完整 display/embedding 正文。 */
export interface IndexVectorRecord {
  readonly vectorId: string;
  readonly manifestId: string;
  readonly spaceId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly chunkId: string;
  readonly ordinal: number;
  readonly contentSha256: string;
  readonly embeddingProfileId: string;
  readonly shortSummary: string;
  readonly headingPath: readonly string[];
  readonly sourceLocations: readonly unknown[];
  readonly dense: readonly number[];
  readonly sparse: SparseVector | null;
}

/** Milvus 对账只返回最小标量事实，严禁回传完整正文或向量。 */
export interface IndexedRecordFact {
  readonly vectorId: string;
  readonly contentSha256: string;
  readonly embeddingProfileId: string;
}

/** 部分写入结果；retryableVectorIds 可有限重试，其余失败必须停止发布。 */
export interface VectorWriteResult {
  readonly succeededVectorIds: readonly string[];
  readonly retryableVectorIds: readonly string[];
  readonly terminalVectorIds: readonly string[];
}

/** 离线向量自检只返回最小文档主键与分数，不返回正文。 */
export interface VectorSearchHit {
  readonly vectorId: string;
  readonly documentId: string;
  readonly score: number;
}

/** Profile 到 Collection/Alias 的唯一访问边界。 */
export interface VectorIndexPort {
  ensureProfileCollection(
    profile: EmbeddingProfile,
    collectionName: string,
    aliasName: string,
    options: ProviderCallOptions,
  ): Promise<void>;
  upsertManifestRecords(
    collectionName: string,
    records: readonly IndexVectorRecord[],
    options: ProviderCallOptions,
  ): Promise<VectorWriteResult>;
  listManifestRecordFacts(
    collectionName: string,
    manifestId: string,
    options: ProviderCallOptions,
  ): Promise<readonly IndexedRecordFact[]>;
  lookupRecordIds(
    collectionName: string,
    manifestId: string,
    vectorIds: readonly string[],
    options: ProviderCallOptions,
  ): Promise<readonly string[]>;
  searchManifestDense(
    collectionName: string,
    manifestId: string,
    dense: readonly number[],
    limit: number,
    options: ProviderCallOptions,
  ): Promise<readonly VectorSearchHit[]>;
  deleteManifestRecords(
    collectionName: string,
    manifestId: string,
    options: ProviderCallOptions,
  ): Promise<void>;
}

/** 开始运行时冻结 Profile 与 Registry 结果，禁止中途随环境变量漂移。 */
export interface BeginIndexingRunCommand {
  readonly jobId: string;
  readonly workerId: string;
  readonly profile: EmbeddingProfile;
  readonly collectionName: string;
  readonly aliasName: string;
}

/** Chunk 到共享 Embedding 事实的来源关系。 */
export interface ChunkEmbeddingReference {
  readonly chunkId: string;
  readonly embeddingFactId: string;
}

/** 原子发布结果用于触发异步旧向量清理。 */
export interface PublishManifestResult {
  readonly manifest: SpaceManifest;
  readonly supersededManifestId: string | null;
}

/** Scheduler 可领取的 M05 跨存储维护任务。 */
export interface IndexMaintenanceTask {
  readonly id: string;
  readonly taskType: 'CLEANUP_MANIFEST' | 'RECONCILE_MANIFEST' | 'REPAIR_MANIFEST';
  readonly manifestId: string;
  readonly collectionName: string;
  readonly manifestStatus: SpaceManifest['status'];
  readonly attempts: number;
}

/** PG 中登记、需要到 MinIO HEAD 核验的来源对象。 */
export interface IndexSourceObject {
  readonly bucket: string;
  readonly objectKey: string;
  readonly sha256: string | null;
}

/** 周期对账所需的 PG 期望快照。 */
export interface IndexMaintenanceSnapshot {
  readonly manifest: SpaceManifest;
  readonly records: readonly IndexVectorRecord[];
  readonly sourceObjects: readonly IndexSourceObject[];
}

/** PG/MinIO/Milvus 周期维护事实端口。 */
export interface IndexMaintenanceRepository {
  claimMaintenanceTasks(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly IndexMaintenanceTask[]>;
  loadMaintenanceSnapshot(manifestId: string): Promise<IndexMaintenanceSnapshot>;
  completeMaintenanceTask(
    taskId: string,
    workerId: string,
    result: Record<string, unknown>,
    nextRunAt: Date | null,
  ): Promise<void>;
  releaseMaintenanceTask(
    taskId: string,
    workerId: string,
    publicMessage: string,
    retryDelaySeconds: number,
    terminal: boolean,
  ): Promise<void>;
}

/** M05 PostgreSQL 事实源端口。 */
export interface IndexingRepository {
  resolveProfileCollection(profile: EmbeddingProfile): Promise<{
    readonly collectionName: string;
    readonly aliasName: string;
  }>;
  beginRun(command: BeginIndexingRunCommand): Promise<IndexBuildInput | undefined>;
  startStep(
    jobId: string,
    workerId: string,
    step: 'EMBED' | 'INDEX' | 'VERIFY' | 'PUBLISH',
    processedUnits: number,
    totalUnits: number,
    publicMessage: string,
  ): Promise<void>;
  findEmbeddingFacts(
    embeddingProfileId: string,
    contentHashes: readonly string[],
  ): Promise<readonly EmbeddingFact[]>;
  saveEmbeddingFacts(
    profile: EmbeddingProfile,
    outputs: readonly EmbeddingOutput[],
  ): Promise<readonly EmbeddingFact[]>;
  saveChunkEmbeddingReferences(
    indexingRunId: string,
    references: readonly ChunkEmbeddingReference[],
    embeddedCount: number,
    reusedCount: number,
  ): Promise<void>;
  markIndexed(indexingRunId: string, indexedCount: number): Promise<void>;
  markVerified(indexingRunId: string, report: IndexReconciliationReport): Promise<void>;
  /** 候选构建完成后释放 Job lease，但保持稳定 Head 不变并排队离线评测。 */
  stageProfileCandidate(
    indexingRunId: string,
    jobId: string,
    workerId: string,
    requestId: string,
  ): Promise<void>;
  publish(indexingRunId: string, jobId: string, workerId: string): Promise<PublishManifestResult>;
  fail(
    indexingRunId: string | null,
    jobId: string,
    workerId: string,
    failureCode: string,
    publicMessage: string,
  ): Promise<void>;
  recordCleanupWarning(manifestId: string, publicMessage: string): Promise<void>;
  getRun(context: AccessContext, indexingRunId: string): Promise<IndexingRun | undefined>;
  getReconciliation(
    context: AccessContext,
    indexingRunId: string,
  ): Promise<IndexReconciliationReport | undefined>;
  listManifests(context: AccessContext, spaceId: string): Promise<readonly SpaceManifest[]>;
  rollback(
    context: AccessContext,
    spaceId: string,
    request: RollbackManifestRequest,
  ): Promise<SpaceManifest>;
  enqueueProfileRebuild(
    context: AccessContext,
    spaceId: string,
    embeddingProfileId: string,
    mode: 'FULL' | 'CANARY',
    canaryPercent: number,
    reason: string,
  ): Promise<string>;
  getProfileRebuild(
    context: AccessContext,
    spaceId: string,
    requestId: string,
  ): Promise<IndexRebuild | undefined>;
  promoteProfileRebuild(
    context: AccessContext,
    spaceId: string,
    requestId: string,
    reason: string,
  ): Promise<SpaceManifest>;
  rollbackProfileRebuild(
    context: AccessContext,
    spaceId: string,
    requestId: string,
    reason: string,
  ): Promise<SpaceManifest>;
}

/** Scheduler 领取的 Profile 重建动作。 */
export interface ProfileRebuildTask {
  readonly requestId: string;
  readonly action: 'BUILD' | 'EVALUATE';
  readonly spaceId: string;
  readonly embeddingProfileId: string;
  readonly mode: 'FULL' | 'CANARY';
  readonly canaryPercent: number;
  readonly attempts: number;
}

/** 自动离线评测使用当前 Manifest 每个文档的代表 Chunk，正文只短暂进入模型。 */
export interface ProfileEvaluationCase {
  readonly caseId: string;
  readonly queryText: string;
  readonly querySha256: string;
  readonly tokenCount: number;
  readonly expectedDocumentId: string;
}

/** 候选 Manifest 与真实评测输入。 */
export interface ProfileCandidateSnapshot {
  readonly requestId: string;
  readonly manifest: SpaceManifest;
  readonly cases: readonly ProfileEvaluationCase[];
}

/** Profile rollout 的持久化状态机端口。 */
export interface ProfileRolloutRepository {
  claimProfileRebuildTasks(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly ProfileRebuildTask[]>;
  prepareProfileRebuild(
    requestId: string,
    workerId: string,
    profile: EmbeddingProfile,
  ): Promise<string>;
  loadProfileCandidate(
    requestId: string,
    workerId: string,
    maxCases: number,
  ): Promise<ProfileCandidateSnapshot>;
  completeProfileEvaluation(
    requestId: string,
    workerId: string,
    report: Record<string, unknown>,
    passed: boolean,
  ): Promise<void>;
  failProfileRebuild(
    requestId: string,
    workerId: string,
    failureCode: string,
    publicMessage: string,
    retryDelaySeconds: number,
    terminal: boolean,
  ): Promise<void>;
}

/** EmbeddingPort 的显式依赖注入 Token。 */
export const EMBEDDING_PORT = Symbol('EMBEDDING_PORT');
/** VectorIndexPort 的显式依赖注入 Token。 */
export const VECTOR_INDEX_PORT = Symbol('VECTOR_INDEX_PORT');
/** IndexingRepository 的显式依赖注入 Token。 */
export const INDEXING_REPOSITORY = Symbol('INDEXING_REPOSITORY');
/** IndexMaintenanceRepository 的显式依赖注入 Token。 */
export const INDEX_MAINTENANCE_REPOSITORY = Symbol('INDEX_MAINTENANCE_REPOSITORY');
/** ProfileRolloutRepository 的显式依赖注入 Token。 */
export const PROFILE_ROLLOUT_REPOSITORY = Symbol('PROFILE_ROLLOUT_REPOSITORY');
