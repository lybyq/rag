/**
 * M04 结构恢复、Chunk、质量门禁和人工审核的运行时契约。
 * API、Worker、PostgreSQL Adapter 与管理端共享这些 Zod Schema，保证审核和索引资格使用同一份事实。
 * 本文件只定义可序列化数据，不执行 Chunk 算法、权限判断或数据库事务。
 *
 * @requirement KNO-001
 * @requirement KNO-004
 * @requirement KNO-006
 * @requirement KNO-010
 * @requirement KNO-011
 * @requirement KNO-012
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';
import { Sha256Schema } from './document-ingestion';
import { NormalizedBoundingBoxSchema, SupportedFileFormatSchema } from './document-parsing';

/** 质量 Policy 的三态结论；未知或执行异常绝不能伪装成 PASS。 */
export const QualityVerdictSchema = z.enum(['PASS', 'MANUAL_REVIEW', 'REJECT']);
export type QualityVerdict = z.infer<typeof QualityVerdictSchema>;

/** 人工审核状态与自动裁决分开保存，避免“审核通过”覆盖原始质量结论。 */
export const QualityReviewDecisionSchema = z.enum([
  'NOT_REQUIRED',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'REPROCESS_REQUESTED',
]);
export type QualityReviewDecision = z.infer<typeof QualityReviewDecisionSchema>;

/** 管理端可以执行的三种审核动作。 */
export const QualityReviewActionSchema = z.enum(['APPROVE', 'REJECT', 'REQUEST_REPROCESS']);
export type QualityReviewAction = z.infer<typeof QualityReviewActionSchema>;

/** 每次知识加工运行保留独立状态，历史 revision 不被新运行覆盖。 */
export const KnowledgeProcessingRunStatusSchema = z.enum([
  'RUNNING',
  'SUCCEEDED',
  'WAITING',
  'FAILED',
  'REJECTED',
]);
export type KnowledgeProcessingRunStatus = z.infer<typeof KnowledgeProcessingRunStatusSchema>;

/** Parent 用于上下文扩展，Child 用于精确检索和引用。 */
export const ChunkGranularitySchema = z.enum(['PARENT', 'CHILD']);
export type ChunkGranularity = z.infer<typeof ChunkGranularitySchema>;

/** Chunk 内容类型决定边界、展示和后续检索策略。 */
export const ChunkContentTypeSchema = z.enum([
  'PROSE',
  'LIST',
  'TABLE',
  'CODE',
  'FAQ',
  'CLAUSE',
  'SLIDE',
  'SHEET',
]);
export type ChunkContentType = z.infer<typeof ChunkContentTypeSchema>;

/** 去重不会删除事实；该状态只控制后续是否进入索引。 */
export const ChunkDedupStatusSchema = z.enum([
  'UNIQUE',
  'RETAINED_DUPLICATE',
  'SUPPRESSED_DUPLICATE',
]);
export type ChunkDedupStatus = z.infer<typeof ChunkDedupStatusSchema>;

/** Chunk 与 Chunk/Block 之间的显式关系类型。 */
export const ChunkRelationTypeSchema = z.enum([
  'PARENT_CHILD',
  'PREVIOUS',
  'NEXT',
  'SOURCE_BLOCK',
  'TABLE_HEADER',
  'FOOTNOTE',
  'DUPLICATE_OF',
]);
export type ChunkRelationType = z.infer<typeof ChunkRelationTypeSchema>;

/** Chunk 的单个来源位置；坐标允许为空，但 Block ID 永远存在。 */
export const ChunkSourceLocationSchema = z.object({
  blockId: z.string().min(1).max(160),
  pageNo: z.number().int().positive().nullable(),
  sheetName: z.string().min(1).max(200).nullable(),
  slideNo: z.number().int().positive().nullable(),
  bbox: NormalizedBoundingBoxSchema.nullable(),
});
export type ChunkSourceLocation = z.infer<typeof ChunkSourceLocationSchema>;

/**
 * 可审核、可定位的知识 Chunk。
 * displayContent 服务原文展示；embeddingText 服务语义检索，二者不能互相覆盖。
 */
export const KnowledgeChunkSchema = z.object({
  id: z.string().min(1).max(180),
  processingRunId: z.uuid(),
  documentVersionId: z.uuid(),
  contentRevision: z.number().int().positive(),
  ordinal: z.number().int().positive(),
  granularity: ChunkGranularitySchema,
  contentType: ChunkContentTypeSchema,
  displayContent: z.string().min(1),
  embeddingText: z.string().min(1),
  tokenCount: z.number().int().positive(),
  tokenizerProfileId: z.string().min(1).max(100),
  tokenizerRevision: z.string().min(1).max(100),
  headingPath: z.array(z.string().min(1).max(500)).max(12),
  sourceLocations: z.array(ChunkSourceLocationSchema).min(1),
  parentChunkId: z.string().min(1).max(180).nullable(),
  contentSha256: Sha256Schema,
  dedupStatus: ChunkDedupStatusSchema,
  duplicateOfChunkId: z.string().min(1).max(180).nullable(),
  eligibleForIndex: z.boolean(),
  splitReason: z.string().min(1).max(100).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

/** 关系目标只能二选一：指向另一个 Chunk，或指向来源 Block。 */
export const ChunkRelationSchema = z
  .object({
    id: z.uuid(),
    processingRunId: z.uuid(),
    fromChunkId: z.string().min(1).max(180),
    relationType: ChunkRelationTypeSchema,
    toChunkId: z.string().min(1).max(180).nullable(),
    toBlockId: z.string().min(1).max(160).nullable(),
    ordinal: z.number().int().nonnegative(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .refine((value) => Number(value.toChunkId !== null) + Number(value.toBlockId !== null) === 1, {
    message: 'ChunkRelation 必须且只能指定一个目标',
  });
export type ChunkRelation = z.infer<typeof ChunkRelationSchema>;

/** 质量发现项使用稳定代码，并能定位到相关页、Block 和 Chunk。 */
export const QualityFindingSchema = z.object({
  id: z.uuid(),
  reportId: z.uuid(),
  severity: z.enum(['INFO', 'WARNING', 'ERROR']),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(500),
  pageNos: z.array(z.number().int().positive()),
  blockIds: z.array(z.string().min(1).max(160)),
  chunkIds: z.array(z.string().min(1).max(180)),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
});
export type QualityFinding = z.infer<typeof QualityFindingSchema>;

/** 质量指标保存计算事实，Policy 升级后仍能解释历史结论。 */
export const DocumentQualityMetricsSchema = z.object({
  expectedPageCount: z.number().int().nonnegative(),
  observedPageCount: z.number().int().nonnegative(),
  nonEmptyBlockRatio: z.number().min(0).max(1),
  averageOcrConfidence: z.number().min(0).max(1).nullable(),
  garbledCharacterRatio: z.number().min(0).max(1),
  duplicateChildRatio: z.number().min(0).max(1),
  tableCount: z.number().int().nonnegative(),
  malformedTableCount: z.number().int().nonnegative(),
  headingCount: z.number().int().nonnegative(),
  childChunkCount: z.number().int().nonnegative(),
  suppressedDuplicateCount: z.number().int().nonnegative(),
  missingPageNos: z.array(z.number().int().positive()),
  hasResponsibleOwner: z.boolean(),
  versionConsistent: z.boolean(),
});
export type DocumentQualityMetrics = z.infer<typeof DocumentQualityMetricsSchema>;

/** 自动结论、人工结论和索引资格集中在同一报告中。 */
export const DocumentQualityReportSchema = z.object({
  id: z.uuid(),
  processingRunId: z.uuid(),
  documentVersionId: z.uuid(),
  contentRevision: z.number().int().positive(),
  verdict: QualityVerdictSchema,
  ruleVersion: z.string().min(1).max(100),
  metrics: DocumentQualityMetricsSchema,
  reviewDecision: QualityReviewDecisionSchema,
  reviewReason: z.string().max(500).nullable(),
  reviewedBy: z.string().max(128).nullable(),
  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  optimisticVersion: z.number().int().positive(),
  eligibleForIndex: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type DocumentQualityReport = z.infer<typeof DocumentQualityReportSchema>;

/** 一次 M04 运行锁定 Parser、Chunker、Tokenizer 和质量规则 revision。 */
export const KnowledgeProcessingRunSchema = z.object({
  id: z.uuid(),
  jobId: z.string().min(1).max(300),
  parseRunId: z.uuid(),
  documentVersionId: z.uuid(),
  contentRevision: z.number().int().positive(),
  fileFormat: SupportedFileFormatSchema,
  status: KnowledgeProcessingRunStatusSchema,
  chunkerProfileId: z.string().min(1).max(100),
  chunkerRevision: z.string().min(1).max(100),
  tokenizerProfileId: z.string().min(1).max(100),
  tokenizerRevision: z.string().min(1).max(100),
  qualityRuleVersion: z.string().min(1).max(100),
  parentChunkCount: z.number().int().nonnegative(),
  childChunkCount: z.number().int().nonnegative(),
  relationCount: z.number().int().nonnegative(),
  failureCode: z.string().max(100).nullable(),
  failureMessage: z.string().max(500).nullable(),
  metrics: z.record(z.string(), z.unknown()),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type KnowledgeProcessingRun = z.infer<typeof KnowledgeProcessingRunSchema>;

/** 审核必须携带看到的版本和明确原因，禁止无理由覆盖。 */
export const ReviewQualityRequestSchema = z.object({
  action: QualityReviewActionSchema,
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(2).max(500),
});
export type ReviewQualityRequest = z.infer<typeof ReviewQualityRequestSchema>;

/** Chunk 使用稳定 ordinal 游标，避免审核期间因其他 revision 写入导致翻页漂移。 */
export const ListKnowledgeChunksQuerySchema = z.object({
  afterOrdinal: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  granularity: ChunkGranularitySchema.optional(),
});
export type ListKnowledgeChunksQuery = z.infer<typeof ListKnowledgeChunksQuerySchema>;

/** 文档版本的知识加工历史。 */
export const KnowledgeProcessingRunListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(KnowledgeProcessingRunSchema) }),
);

/** 运行详情同时返回质量报告和发现项。 */
export const KnowledgeProcessingRunDetailEnvelopeSchema = createApiEnvelopeSchema(
  z.object({
    run: KnowledgeProcessingRunSchema,
    report: DocumentQualityReportSchema,
    findings: z.array(QualityFindingSchema),
  }),
);

/** Chunk 分页结果。 */
export const KnowledgeChunkListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({
    items: z.array(KnowledgeChunkSchema),
    nextOrdinal: z.number().int().positive().nullable(),
  }),
);

/** 审核成功后返回更新后的报告以及可选的新重处理任务 ID。 */
export const QualityReviewResultEnvelopeSchema = createApiEnvelopeSchema(
  z.object({
    report: DocumentQualityReportSchema,
    reprocessJobId: z.string().min(1).max(300).nullable(),
  }),
);
