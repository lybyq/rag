/**
 * M05 向量化、索引构建、对账与发布的跨进程运行时契约。
 *
 * 这些 Schema 是 HTTP Provider、Worker、PostgreSQL 与 Milvus Adapter 之间的共同事实源。
 * 本文件不选择具体模型、不连接 Milvus，也不决定发布事务；供应商差异必须停留在 Adapter。
 *
 * @requirement IDX-001
 * @requirement IDX-002
 * @requirement IDX-008
 * @requirement IDX-010
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';
import { ProviderProfileSchema } from './provider-profile';

const TimestampSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Embedding 端点用途；查询与文档不能依赖调用者自由拼字符串。 */
export const EmbeddingPurposeSchema = z.enum(['QUERY', 'DOCUMENT']);
/** Embedding 调用用途的 TypeScript 类型。 */
export type EmbeddingPurpose = z.infer<typeof EmbeddingPurposeSchema>;

/** Sparse 向量的稳定格式版本；索引和值数组必须一一对应且索引严格递增。 */
export const SparseVectorSchema = z
  .object({
    indices: z.array(z.number().int().nonnegative()).max(131_072),
    values: z.array(z.number().finite()).max(131_072),
  })
  .superRefine((value, context) => {
    if (value.indices.length !== value.values.length) {
      context.addIssue({ code: 'custom', path: ['values'], message: 'Sparse 索引和值数量不一致' });
    }
    for (let index = 1; index < value.indices.length; index += 1) {
      if ((value.indices[index] ?? 0) <= (value.indices[index - 1] ?? -1)) {
        context.addIssue({
          code: 'custom',
          path: ['indices', index],
          message: 'Sparse 索引必须严格递增且不得重复',
        });
      }
    }
  });
/** 稀疏向量的 TypeScript 类型，索引和值使用相同位置关联。 */
export type SparseVector = z.infer<typeof SparseVectorSchema>;

/** 不可变 Embedding Profile；兼容性字段变化时必须创建新 Profile。 */
export const EmbeddingProfileSchema = z.object({
  profileId: z.string().trim().min(1).max(100),
  providerProfile: ProviderProfileSchema,
  provider: z.string().trim().min(1).max(100),
  modelId: z.string().trim().min(1).max(160),
  revision: z.string().trim().min(1).max(100),
  protocolVersion: z.string().trim().min(1).max(40),
  tokenizerRevision: z.string().trim().min(1).max(100),
  denseDimension: z.number().int().min(1).max(65_536),
  normalizeDense: z.boolean(),
  sparseFormatVersion: z.string().trim().min(1).max(100).nullable(),
  documentTemplateVersion: z.string().trim().min(1).max(100),
  queryTemplateVersion: z.string().trim().min(1).max(100),
  maxInputTokens: z.number().int().min(1).max(131_072),
  maxBatchSize: z.number().int().min(1).max(1_024),
});
/** 冻结后的 Embedding 语义配置；任一不兼容字段变化都应创建新 Profile。 */
export type EmbeddingProfile = z.infer<typeof EmbeddingProfileSchema>;

/** Provider `/metadata` 必须返回的真实能力，用于启动时 fail-closed 比对。 */
export const EmbeddingProviderMetadataSchema = EmbeddingProfileSchema.omit({
  profileId: true,
  providerProfile: true,
  documentTemplateVersion: true,
  queryTemplateVersion: true,
}).extend({
  capabilities: z.array(z.enum(['query', 'document', 'dense', 'sparse'])).min(3),
});
/** Provider 在 `/metadata` 返回的能力事实，不包含平台生成的 Profile 字段。 */
export type EmbeddingProviderMetadata = z.infer<typeof EmbeddingProviderMetadataSchema>;

/** 单条 Embedding 输入；itemId 只用于批次关联，文本不得写入日志。 */
export const EmbeddingInputSchema = z.object({
  itemId: z.string().min(1).max(200),
  contentSha256: Sha256Schema,
  text: z.string().min(1),
  tokenCount: z.number().int().positive(),
});
/** 单条 Embedding 输入；itemId 与内容 Hash 用于校验批次响应关联。 */
export type EmbeddingInput = z.infer<typeof EmbeddingInputSchema>;

/** 单条成功结果必须携带模型事实，防止网关静默切换模型。 */
export const EmbeddingOutputSchema = z.object({
  itemId: z.string().min(1).max(200),
  contentSha256: Sha256Schema,
  dense: z.array(z.number().finite()).min(1).max(65_536),
  sparse: SparseVectorSchema.nullable(),
  modelId: z.string().min(1).max(160),
  revision: z.string().min(1).max(100),
});
/** 单条成功向量结果；Dense/Sparse 都经过运行时 Schema 校验。 */
export type EmbeddingOutput = z.infer<typeof EmbeddingOutputSchema>;

/** 部分失败不会让成功项丢失；仅 retryable=true 的项可以有限重试。 */
export const EmbeddingItemFailureSchema = z.object({
  itemId: z.string().min(1).max(200),
  code: z.enum([
    'TIMEOUT',
    'CANCELLED',
    'RATE_LIMITED',
    'UPSTREAM_5XX',
    'INVALID_INPUT',
    'SCHEMA_ERROR',
  ]),
  retryable: z.boolean(),
  publicMessage: z.string().min(1).max(300),
});
/** 单条失败结果；retryable 明确决定是否允许进入有限重试。 */
export type EmbeddingItemFailure = z.infer<typeof EmbeddingItemFailureSchema>;

/** Provider 批次响应，成功和失败 itemId 不得重复。 */
export const EmbeddingBatchResponseSchema = z
  .object({
    outputs: z.array(EmbeddingOutputSchema),
    failures: z.array(EmbeddingItemFailureSchema),
  })
  .superRefine((value, context) => {
    const ids = [...value.outputs, ...value.failures].map((item) => item.itemId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Embedding 响应包含重复 itemId' });
    }
  });
/** Embedding 批次响应；成功项与失败项共同构成输入集合的完整响应。 */
export type EmbeddingBatchResponse = z.infer<typeof EmbeddingBatchResponseSchema>;

/** M05 Run 状态按真实外部副作用推进；FAILED 允许以同一 Run 安全重试。 */
export const IndexingRunStatusSchema = z.enum([
  'BUILDING',
  'EMBEDDING',
  'INDEXING',
  'VERIFYING',
  'VERIFIED',
  'PUBLISHED',
  'FAILED',
  'CANCELLED',
]);
/** 单次索引运行的状态机状态。 */
export type IndexingRunStatus = z.infer<typeof IndexingRunStatusSchema>;

/** 空间 Manifest 是不可变发布快照；ACTIVE 只能由 PG 原子切换产生。 */
export const SpaceManifestStatusSchema = z.enum([
  'BUILDING',
  'VERIFIED',
  'ACTIVE',
  'SUPERSEDED',
  'REVOKED',
  'FAILED',
]);
/** 空间 Manifest 的发布生命周期状态。 */
export type SpaceManifestStatus = z.infer<typeof SpaceManifestStatusSchema>;

/** M05 运行事实，保存实际使用的部署画像和 Embedding revision。 */
export const IndexingRunSchema = z.object({
  id: z.uuid(),
  jobId: z.string().min(1).max(300),
  spaceId: z.uuid(),
  documentVersionId: z.uuid(),
  contentRevision: z.number().int().positive(),
  embeddingRevision: z.number().int().positive(),
  providerProfile: ProviderProfileSchema,
  embeddingProfileId: z.string().min(1).max(100),
  embeddingModelId: z.string().min(1).max(160),
  embeddingModelRevision: z.string().min(1).max(100),
  collectionName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,254}$/),
  manifestId: z.uuid(),
  manifestVersion: z.number().int().positive(),
  status: IndexingRunStatusSchema,
  expectedVectorCount: z.number().int().nonnegative(),
  embeddedCount: z.number().int().nonnegative(),
  reusedCount: z.number().int().nonnegative(),
  indexedCount: z.number().int().nonnegative(),
  failureCode: z.string().max(100).nullable(),
  failureMessage: z.string().max(500).nullable(),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
/** 单次索引构建运行事实。 */
export type IndexingRun = z.infer<typeof IndexingRunSchema>;

/** 单个发布快照，精确锁定内容、模型、Collection 和向量数量。 */
export const SpaceManifestSchema = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  version: z.number().int().positive(),
  status: SpaceManifestStatusSchema,
  providerProfile: ProviderProfileSchema,
  embeddingProfileId: z.string().min(1).max(100),
  embeddingModelId: z.string().min(1).max(160),
  embeddingModelRevision: z.string().min(1).max(100),
  tokenizerRevision: z.string().min(1).max(100),
  denseDimension: z.number().int().positive(),
  normalizeDense: z.boolean(),
  sparseFormatVersion: z.string().min(1).max(100).nullable(),
  collectionName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,254}$/),
  expectedVectorCount: z.number().int().nonnegative(),
  actualVectorCount: z.number().int().nonnegative(),
  reconciliationSha256: Sha256Schema.nullable(),
  activatedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
/** 知识空间某一时刻的完整可发布成员快照。 */
export type SpaceManifest = z.infer<typeof SpaceManifestSchema>;

/** Manifest 的文档成员；同一文档只允许一个业务版本进入一个 Manifest。 */
export const ManifestDocumentMemberSchema = z.object({
  manifestId: z.uuid(),
  documentId: z.uuid(),
  documentVersionId: z.uuid(),
  contentRevision: z.number().int().positive(),
  embeddingRevision: z.number().int().positive(),
  vectorCount: z.number().int().nonnegative(),
});
/** Manifest 中一个独立文档来源的发布成员。 */
export type ManifestDocumentMember = z.infer<typeof ManifestDocumentMemberSchema>;

/** 对账问题只保存稳定代码和主键，不包含 Chunk 正文或模型密钥。 */
export const IndexReconciliationIssueSchema = z.object({
  code: z.enum([
    'COUNT_MISMATCH',
    'MISSING_PRIMARY_KEY',
    'UNEXPECTED_PRIMARY_KEY',
    'CONTENT_HASH_MISMATCH',
    'PROFILE_MISMATCH',
    'FIXED_QUERY_MISMATCH',
    'SOURCE_OBJECT_MISSING',
  ]),
  vectorId: z.string().max(200).nullable(),
  publicMessage: z.string().min(1).max(300),
  repairable: z.boolean(),
});
/** 一条脱敏对账问题，只记录标识与分类，不记录正文。 */
export type IndexReconciliationIssue = z.infer<typeof IndexReconciliationIssueSchema>;

/** 发布前的可重放对账报告；passed=false 时禁止切换 Manifest。 */
export const IndexReconciliationReportSchema = z.object({
  manifestId: z.uuid(),
  expectedCount: z.number().int().nonnegative(),
  actualCount: z.number().int().nonnegative(),
  checkedPrimaryKeys: z.number().int().nonnegative(),
  fixedQueriesPassed: z.number().int().nonnegative(),
  issues: z.array(IndexReconciliationIssueSchema),
  passed: z.boolean(),
  reportSha256: Sha256Schema,
});
/** 候选 Manifest 的完整对账报告。 */
export type IndexReconciliationReport = z.infer<typeof IndexReconciliationReportSchema>;

/** 管理端触发 Profile 全量重建或灰度构建，不允许携带任意 Collection 名。 */
export const StartIndexRebuildRequestSchema = z
  .object({
    embeddingProfileId: z.string().trim().min(1).max(100),
    mode: z.enum(['FULL', 'CANARY']),
    canaryPercent: z.number().int().min(1).max(100).default(10),
    reason: z.string().trim().min(3).max(500),
  })
  .superRefine((value, context) => {
    if (value.mode === 'CANARY' && value.canaryPercent >= 100) {
      context.addIssue({
        code: 'custom',
        path: ['canaryPercent'],
        message: 'CANARY 比例必须小于 100；全量发布请使用 FULL',
      });
    }
  });
/** 新 Profile 全量重建的管理端请求。 */
export type StartIndexRebuildRequest = z.infer<typeof StartIndexRebuildRequestSchema>;

/** Profile rollout 持久化状态；READY 表示 CANARY 已登记但尚未提升为稳定版本。 */
export const IndexRebuildStatusSchema = z.enum([
  'QUEUED',
  'BUILDING',
  'EVALUATING',
  'READY',
  'PUBLISHED',
  'ROLLED_BACK',
  'FAILED',
]);
/** Profile 重建、评测、灰度和回退工作流状态。 */
export type IndexRebuildStatus = z.infer<typeof IndexRebuildStatusSchema>;

/** Profile 重建、评测和发布审计视图。 */
export const IndexRebuildSchema = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  embeddingProfileId: z.string().min(1).max(100),
  mode: z.enum(['FULL', 'CANARY']),
  canaryPercent: z.number().int().min(1).max(100),
  status: IndexRebuildStatusSchema,
  candidateManifestId: z.uuid().nullable(),
  previousManifestId: z.uuid().nullable(),
  pipelineJobId: z.string().max(300).nullable(),
  evaluationReport: z.record(z.string(), z.unknown()).nullable(),
  failureCode: z.string().max(100).nullable(),
  failureMessage: z.string().max(500).nullable(),
  createdAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
});
/** Profile 重建请求及其脱敏评测结果。 */
export type IndexRebuild = z.infer<typeof IndexRebuildSchema>;

/** 提升或回退 Profile 候选必须给出审计原因。 */
export const IndexRebuildDecisionRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
/** 提升或回退 Profile 候选时的审计原因。 */
export type IndexRebuildDecisionRequest = z.infer<typeof IndexRebuildDecisionRequestSchema>;

/** 回滚只能选择已验证的历史 Manifest，并要求说明原因。 */
export const RollbackManifestRequestSchema = z.object({
  targetManifestVersion: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500),
});
/** 按版本回滚空间 Manifest 的管理端请求。 */
export type RollbackManifestRequest = z.infer<typeof RollbackManifestRequestSchema>;

/** 索引运行详情 API Envelope。 */
export const IndexingRunEnvelopeSchema = createApiEnvelopeSchema(IndexingRunSchema);
/** 单个空间 Manifest API Envelope。 */
export const SpaceManifestEnvelopeSchema = createApiEnvelopeSchema(SpaceManifestSchema);
/** 空间 Manifest 列表 API Envelope。 */
export const SpaceManifestListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(SpaceManifestSchema) }),
);
/** 索引对账报告 API Envelope。 */
export const IndexReconciliationEnvelopeSchema = createApiEnvelopeSchema(
  IndexReconciliationReportSchema,
);
/** Profile 重建请求已可靠入队的响应。 */
export const StartIndexRebuildEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ requestId: z.uuid() }),
);
/** Profile 重建状态响应。 */
export const IndexRebuildEnvelopeSchema = createApiEnvelopeSchema(IndexRebuildSchema);
