/**
 * 评测与生产可靠性的公共运行时契约。
 *
 * 本文件描述版本化评测集、Case、执行快照、指标、基线和失败样本。它位于 HTTP、
 * PostgreSQL 与 Worker 之间，确保外网 Golden 回归和内网真实模型评测使用同一套数据形状。
 * 契约不负责执行模型、访问数据库或决定用户权限。
 *
 * @requirement OPS-001
 * @requirement OPS-002
 * @requirement OPS-003
 * @requirement OPS-004
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';
import { EvidenceRouteSchema, FinalAnswerStatusSchema } from './answer-generation';

/** 评测覆盖的九类质量与安全维度。 */
export const EvaluationDimensionSchema = z.enum([
  'PARSING',
  'CHUNKING',
  'RETRIEVAL',
  'CITATION',
  'ANSWER',
  'REFUSAL',
  'CONFLICT',
  'AUTHORIZATION',
  'SECURITY',
]);
/** 评测维度。 */
export type EvaluationDimension = z.infer<typeof EvaluationDimensionSchema>;

/** 数据集生命周期；ACTIVE 版本不可原地改写，只能创建新版本。 */
export const EvaluationDatasetStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);
/** 数据集状态。 */
export type EvaluationDatasetStatus = z.infer<typeof EvaluationDatasetStatusSchema>;

/** 单条 Case 的确定性期望。空数组表示该字段不参与评分。 */
export const EvaluationExpectationSchema = z
  .object({
    expectedDocumentIds: z.array(z.uuid()).max(100).default([]),
    expectedChunkIds: z.array(z.string().min(1).max(180)).max(200).default([]),
    expectedCitationDocumentIds: z.array(z.uuid()).max(100).default([]),
    answerMustInclude: z.array(z.string().min(1).max(200)).max(50).default([]),
    answerMustNotInclude: z.array(z.string().min(1).max(200)).max(50).default([]),
    expectedRoute: EvidenceRouteSchema.optional(),
    expectedFinalStatus: FinalAnswerStatusSchema.optional(),
    expectedAccess: z.enum(['ALLOW', 'DENY']).optional(),
    minimumParseCoverage: z.number().min(0).max(1).optional(),
    requireChunkBoundaryPass: z.boolean().optional(),
    maximumLatencyMs: z.number().int().positive().max(300_000).optional(),
  })
  .strict();
/** Case 期望。 */
export type EvaluationExpectation = z.infer<typeof EvaluationExpectationSchema>;

/**
 * 真实执行产出的标准化事实。
 * Worker 从 Run、引用和校验报告构造该对象；只有 Parser/Chunk Golden Case 可以提交 fixture。
 */
export const EvaluationActualSchema = z
  .object({
    retrievedDocumentIds: z.array(z.uuid()).max(200).default([]),
    retrievedChunkIds: z.array(z.string().min(1).max(180)).max(500).default([]),
    citationDocumentIds: z.array(z.uuid()).max(200).default([]),
    claims: z
      .array(
        z
          .object({
            text: z.string().min(1).max(2_000),
            supported: z.boolean(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    route: EvidenceRouteSchema.optional(),
    finalStatus: FinalAnswerStatusSchema.optional(),
    accessDecision: z.enum(['ALLOW', 'DENY']).optional(),
    parseCoverage: z.number().min(0).max(1).optional(),
    chunkBoundaryPass: z.boolean().optional(),
    securityViolations: z.array(z.string().min(1).max(120)).max(50).default([]),
    responseLatencyMs: z.number().int().nonnegative().max(300_000).optional(),
  })
  .strict();
/** 标准化实际事实。 */
export type EvaluationActual = z.infer<typeof EvaluationActualSchema>;

/**
 * Case 的基础对象 Schema。
 * 单独保留无 refinement 的对象，是因为 Zod 4 禁止对带 refinement 的 Schema 直接 omit；
 * HTTP 请求在下方追加跨字段规则，持久化视图则可以安全复用同一组字段定义。
 */
const EvaluationCaseInputObjectSchema = z
  .object({
    externalKey: z.string().min(1).max(120),
    title: z.string().min(1).max(240),
    dimension: EvaluationDimensionSchema,
    question: z.string().min(1).max(8_000).optional(),
    requestedSpaceIds: z.array(z.uuid()).max(20).default([]),
    documentVersionId: z.uuid().optional(),
    processingRunId: z.uuid().optional(),
    expectation: EvaluationExpectationSchema,
    fixtureActual: EvaluationActualSchema.optional(),
    tags: z.array(z.string().min(1).max(60)).max(30).default([]),
  })
  .strict();

/** 可写入评测集的新 Case。问题必须是合成、公开或已批准脱敏数据。 */
export const CreateEvaluationCaseRequestSchema = EvaluationCaseInputObjectSchema.superRefine(
  (value, context) => {
    const ragDimension = !['PARSING', 'CHUNKING'].includes(value.dimension);
    if (ragDimension && (!value.question || value.requestedSpaceIds.length === 0)) {
      context.addIssue({
        code: 'custom',
        message: 'RAG 评测 Case 必须提供问题和至少一个知识空间',
      });
    }
    if (
      !ragDimension &&
      !value.fixtureActual &&
      !value.documentVersionId &&
      !value.processingRunId
    ) {
      context.addIssue({
        code: 'custom',
        message: '解析或 Chunk Case 必须绑定事实对象或提供 Golden fixture',
      });
    }
  },
);
/** 新建 Case 请求。 */
export type CreateEvaluationCaseRequest = z.input<typeof CreateEvaluationCaseRequestSchema>;

/** 新建版本化评测集请求。 */
export const CreateEvaluationDatasetRequestSchema = z
  .object({
    name: z.string().min(2).max(160),
    description: z.string().min(2).max(2_000),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/),
    cases: z.array(CreateEvaluationCaseRequestSchema).min(1).max(5_000),
  })
  .strict();
/** 新建评测集请求。 */
export type CreateEvaluationDatasetRequest = z.input<typeof CreateEvaluationDatasetRequestSchema>;

/** 评测集摘要。 */
export const EvaluationDatasetSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string(),
    version: z.string(),
    status: EvaluationDatasetStatusSchema,
    caseCount: z.number().int().nonnegative(),
    createdBy: z.string().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
/** 评测集摘要。 */
export type EvaluationDataset = z.infer<typeof EvaluationDatasetSchema>;

/** 持久化 Case；ordinal 提供版本内稳定顺序。 */
export const EvaluationCaseSchema = EvaluationCaseInputObjectSchema.omit({ fixtureActual: true })
  .extend({
    id: z.uuid(),
    datasetId: z.uuid(),
    ordinal: z.number().int().positive(),
    hasFixtureActual: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .strict();
/** 评测 Case。 */
export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;

/** 一次运行锁定的可重放版本事实。 */
export const EvaluationSnapshotSchema = z
  .object({
    flowVersion: z.string().min(1),
    policyVersion: z.string().min(1),
    promptProfileId: z.string().min(1),
    embeddingProfileId: z.string().min(1),
    embeddingRevision: z.string().min(1),
    rerankerProfileId: z.string().min(1),
    rerankerRevision: z.string().min(1),
    llmProfileId: z.string().min(1),
    llmRevision: z.string().min(1),
    validatorProfileId: z.string().min(1),
    manifestIds: z.array(z.uuid()).max(200),
    codeVersion: z.string().min(1).max(120),
  })
  .strict();
/** 评测运行快照。 */
export type EvaluationSnapshot = z.infer<typeof EvaluationSnapshotSchema>;

/** 创建异步评测运行。 */
export const CreateEvaluationRunRequestSchema = z
  .object({
    datasetId: z.uuid(),
    baselineId: z.uuid().optional(),
    note: z.string().max(500).optional(),
    codeVersion: z.string().min(1).max(120).default('working-tree'),
  })
  .strict();
/** 创建运行请求。 */
export type CreateEvaluationRunRequest = z.input<typeof CreateEvaluationRunRequestSchema>;

/** 评测运行状态。 */
export const EvaluationRunStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
/** 评测运行状态。 */
export type EvaluationRunStatus = z.infer<typeof EvaluationRunStatusSchema>;

/** PRD 与安全门禁中使用的稳定指标名。 */
export const EvaluationMetricNameSchema = z.enum([
  'ANSWERABLE_RECALL_AT_40',
  'HIT_AT_5',
  'CITATION_PRECISION',
  'UNSUPPORTED_CLAIM_RATE',
  'REFUSAL_ACCURACY',
  'VERSION_SCOPE_ACCURACY',
  'PERMISSION_LEAK_RATE',
  'PARSING_ACCURACY',
  'CHUNK_BOUNDARY_ACCURACY',
  'SECURITY_PASS_RATE',
  'LATENCY_PASS_RATE',
]);
/** 稳定指标名。 */
export type EvaluationMetricName = z.infer<typeof EvaluationMetricNameSchema>;

/** 指标汇总包含样本数和方差，避免只看均值掩盖波动。 */
export const EvaluationMetricSchema = z
  .object({
    name: EvaluationMetricNameSchema,
    value: z.number().finite(),
    threshold: z.number().finite(),
    comparator: z.enum(['GTE', 'LTE', 'EQ']),
    passed: z.boolean(),
    sampleCount: z.number().int().nonnegative(),
    variance: z.number().nonnegative(),
  })
  .strict();
/** 指标汇总。 */
export type EvaluationMetric = z.infer<typeof EvaluationMetricSchema>;

/** 单 Case 结果用于失败样本下钻，不保存模型思维链。 */
export const EvaluationCaseResultSchema = z
  .object({
    id: z.uuid(),
    evaluationRunId: z.uuid(),
    caseId: z.uuid(),
    ragRunId: z.uuid().nullable(),
    status: z.enum(['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERROR']),
    scores: z.record(z.string(), z.number().finite()),
    failureCodes: z.array(z.string().min(1).max(120)),
    actual: EvaluationActualSchema.nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();
/** Case 结果。 */
export type EvaluationCaseResult = z.infer<typeof EvaluationCaseResultSchema>;

/** 评测运行摘要。 */
export const EvaluationRunSchema = z
  .object({
    id: z.uuid(),
    datasetId: z.uuid(),
    datasetName: z.string(),
    datasetVersion: z.string(),
    baselineId: z.uuid().nullable(),
    status: EvaluationRunStatusSchema,
    snapshot: EvaluationSnapshotSchema,
    totalCases: z.number().int().nonnegative(),
    completedCases: z.number().int().nonnegative(),
    passedCases: z.number().int().nonnegative(),
    metrics: z.array(EvaluationMetricSchema),
    createdBy: z.string().min(1),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();
/** 评测运行。 */
export type EvaluationRun = z.infer<typeof EvaluationRunSchema>;

/** 可提升为后续比较基准的不可变基线。 */
export const EvaluationBaselineSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    evaluationRunId: z.uuid(),
    datasetId: z.uuid(),
    snapshot: EvaluationSnapshotSchema,
    metrics: z.array(EvaluationMetricSchema),
    createdBy: z.string().min(1),
    createdAt: z.iso.datetime(),
  })
  .strict();
/** 评测基线。 */
export type EvaluationBaseline = z.infer<typeof EvaluationBaselineSchema>;

/** 基线提升请求。 */
export const PromoteEvaluationBaselineRequestSchema = z
  .object({ name: z.string().min(2).max(160), reason: z.string().min(2).max(500) })
  .strict();
/** 基线提升请求。 */
export type PromoteEvaluationBaselineRequest = z.infer<
  typeof PromoteEvaluationBaselineRequestSchema
>;

/** 运行详情包含失败样本，默认最多返回 200 条。 */
export const EvaluationRunDetailSchema = z
  .object({
    run: EvaluationRunSchema,
    results: z.array(EvaluationCaseResultSchema).max(200),
    baseline: EvaluationBaselineSchema.nullable(),
    regressions: z.array(z.string().min(1).max(240)),
  })
  .strict();
/** 运行详情。 */
export type EvaluationRunDetail = z.infer<typeof EvaluationRunDetailSchema>;

/** 列表响应。 */
export const EvaluationDatasetListSchema = z
  .object({ items: z.array(EvaluationDatasetSchema) })
  .strict();
/** 运行列表响应。 */
export const EvaluationRunListSchema = z.object({ items: z.array(EvaluationRunSchema) }).strict();
/** 基线列表响应。 */
export const EvaluationBaselineListSchema = z
  .object({ items: z.array(EvaluationBaselineSchema) })
  .strict();

/** 评测集和稳定顺序 Case 的详情。 */
export const EvaluationDatasetDetailSchema = z
  .object({ dataset: EvaluationDatasetSchema, cases: z.array(EvaluationCaseSchema) })
  .strict();

/** 评测数据集列表统一响应。 */
export const EvaluationDatasetListEnvelopeSchema = createApiEnvelopeSchema(
  EvaluationDatasetListSchema,
);
/** 单个评测数据集统一响应。 */
export const EvaluationDatasetEnvelopeSchema = createApiEnvelopeSchema(EvaluationDatasetSchema);
/** 评测数据集详情统一响应。 */
export const EvaluationDatasetDetailEnvelopeSchema = createApiEnvelopeSchema(
  EvaluationDatasetDetailSchema,
);
/** 评测运行列表统一响应。 */
export const EvaluationRunListEnvelopeSchema = createApiEnvelopeSchema(EvaluationRunListSchema);
/** 单个评测运行统一响应。 */
export const EvaluationRunEnvelopeSchema = createApiEnvelopeSchema(EvaluationRunSchema);
/** 评测运行详情统一响应。 */
export const EvaluationRunDetailEnvelopeSchema = createApiEnvelopeSchema(EvaluationRunDetailSchema);
/** 基线提升统一响应。 */
export const EvaluationBaselineEnvelopeSchema = createApiEnvelopeSchema(EvaluationBaselineSchema);
