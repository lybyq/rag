/**
 * 证据、生成与答案校验的跨进程运行时契约。
 *
 * 本文件定义 Reranker、Evidence Builder、结构化 LLM Draft、确定性校验、语义 Judge、
 * 最终答案和引用预览共同使用的唯一数据形状。模型只能提交 `AnswerDraft`，不能直接决定
 * `FinalAnswer`；最终状态必须由服务端路由和校验器产生。
 *
 * @requirement ANS-001
 * @requirement ANS-005
 * @requirement ANS-009
 * @requirement ANS-010
 * @requirement ANS-016
 * @requirement ANS-017
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';

const TimestampSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** 候选精排时发给 Reranker 的最小文档。 */
export const RerankDocumentSchema = z.object({
  candidateId: z.string().min(1).max(180),
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(200_000),
});
/** Reranker 输入文档类型。 */
export type RerankDocument = z.infer<typeof RerankDocumentSchema>;

/** 单个候选的精排结果；candidateId 必须来自请求集合。 */
export const RerankScoreSchema = z.object({
  candidateId: z.string().min(1).max(180),
  score: z.number().finite(),
  rank: z.number().int().positive(),
});
/** 候选精排分数类型。 */
export type RerankScore = z.infer<typeof RerankScoreSchema>;

/** Reranker 返回的锁定模型事实和完整结果。 */
export const RerankResponseSchema = z.object({
  modelId: z.string().min(1).max(160),
  revision: z.string().min(1).max(100),
  scores: z.array(RerankScoreSchema).max(1_000),
});
/** Reranker 响应类型。 */
export type RerankResponse = z.infer<typeof RerankResponseSchema>;

/** Evidence 扩展关系；SELF 是原始命中，其余关系来自服务端 Chunk 图。 */
export const EvidenceRelationSchema = z.enum([
  'SELF',
  'PARENT',
  'PREVIOUS',
  'NEXT',
  'TABLE_HEADER',
]);
/** Evidence 扩展关系类型。 */
export type EvidenceRelation = z.infer<typeof EvidenceRelationSchema>;

/** 企业知识来源的权威级别；未知来源不会被默认为制度。 */
export const EvidenceAuthoritySchema = z.enum([
  'POLICY',
  'PROCEDURE',
  'GUIDANCE',
  'REFERENCE',
  'UNKNOWN',
]);
/** 来源权威级别类型。 */
export type EvidenceAuthority = z.infer<typeof EvidenceAuthoritySchema>;

/**
 * 通过当前权限、Manifest、文档版本和生效时间复核后的证据材料。
 * sourceId 是服务端生成的不透明 UUID；客户端和模型不能用数据库主键伪造引用。
 */
export const EvidenceSourceSchema = z.object({
  sourceId: z.uuid(),
  relation: EvidenceRelationSchema,
  originCandidateId: z.string().min(1).max(180),
  manifestId: z.uuid(),
  spaceId: z.uuid(),
  documentId: z.uuid(),
  documentVersionId: z.uuid(),
  contentRevision: z.number().int().positive(),
  chunkId: z.string().min(1).max(180),
  title: z.string().min(1).max(240),
  headingPath: z.array(z.string().max(500)).max(100),
  content: z.string().min(1).max(200_000),
  sourceLocations: z.array(z.unknown()).max(10_000),
  authority: EvidenceAuthoritySchema,
  publishedAt: TimestampSchema,
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.nullable(),
  retrievalScore: z.number().finite(),
  rerankerScore: z.number().finite(),
  subQuestionIndexes: z.array(z.number().int().nonnegative()).max(4),
});
/** 已复核证据来源类型。 */
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

/** 一个子问题的证据覆盖情况。 */
export const EvidenceCoverageSchema = z.object({
  subQuestionIndex: z.number().int().nonnegative(),
  subQuestion: z.string().min(1).max(2_000),
  status: z.enum(['COVERED', 'PARTIAL', 'MISSING']),
  sourceIds: z.array(z.uuid()).max(100),
  confidence: z.number().min(0).max(1),
});
/** 子问题覆盖类型。 */
export type EvidenceCoverage = z.infer<typeof EvidenceCoverageSchema>;

/** 两个来源对同一可程序化事实给出不同值。 */
export const EvidenceConflictSchema = z.object({
  kind: z.enum(['AMOUNT', 'DATE', 'VERSION', 'CODE']),
  normalizedValues: z.array(z.string().min(1).max(200)).min(2).max(20),
  sourceIds: z.array(z.uuid()).min(2).max(100),
  description: z.string().min(1).max(500),
});
/** 证据冲突类型。 */
export type EvidenceConflict = z.infer<typeof EvidenceConflictSchema>;

/** 证据仍缺少的业务条件，必须向用户显式暴露。 */
export const EvidenceMissingConditionSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/),
  description: z.string().min(1).max(500),
  subQuestionIndexes: z.array(z.number().int().nonnegative()).max(4),
});
/** 缺失条件类型。 */
export type EvidenceMissingCondition = z.infer<typeof EvidenceMissingConditionSchema>;

/** Evidence Builder 的完整产物。 */
export const EvidenceBundleSchema = z.object({
  runId: z.uuid(),
  bundleSha256: Sha256Schema,
  sources: z.array(EvidenceSourceSchema).max(100),
  coverage: z.array(EvidenceCoverageSchema).max(4),
  conflicts: z.array(EvidenceConflictSchema).max(100),
  missingConditions: z.array(EvidenceMissingConditionSchema).max(100),
  confidence: z.number().min(0).max(1),
  degraded: z.boolean(),
});
/** 证据包类型。 */
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

/** 证据状态机的唯一允许路由。 */
export const EvidenceRouteSchema = z.enum([
  'ANSWER',
  'LLM_RERANK',
  'REWRITE_AND_RETRY',
  'CLARIFY',
  'CONFLICT',
  'PARTIAL_ANSWER',
  'REJECT',
]);
/** 证据路由类型。 */
export type EvidenceRoute = z.infer<typeof EvidenceRouteSchema>;

/** 确定性计算保存表达式、结果和来源，模型不能重新计算或改写结果。 */
export const DeterministicCalculationSchema = z.object({
  calculationId: z.uuid(),
  expression: z.string().min(1).max(1_000),
  result: z.string().min(1).max(1_000),
  sourceIds: z.array(z.uuid()).min(1).max(100),
});
/** 确定性计算类型。 */
export type DeterministicCalculation = z.infer<typeof DeterministicCalculationSchema>;

/** 注入安全的模型上下文；边界标记由服务端生成。 */
export const AnswerContextSchema = z.object({
  text: z.string().min(1).max(1_000_000),
  includedSourceIds: z.array(z.uuid()).max(100),
  omittedSourceIds: z.array(z.uuid()).max(100),
  estimatedTokens: z.number().int().positive(),
  tokenBudget: z.number().int().positive(),
});
/** 生成上下文类型。 */
export type AnswerContext = z.infer<typeof AnswerContextSchema>;

/** Claim 类型决定必须执行的确定性校验。 */
export const AnswerClaimKindSchema = z.enum(['FACT', 'CALCULATION', 'QUALIFICATION', 'WARNING']);
/** Claim 类型。 */
export type AnswerClaimKind = z.infer<typeof AnswerClaimKindSchema>;

/** 模型产出的结构化 Claim；每条必须至少引用一个 sourceId。 */
export const AnswerClaimSchema = z.object({
  claimId: z.string().regex(/^claim-[1-9][0-9]{0,3}$/),
  kind: AnswerClaimKindSchema,
  text: z.string().trim().min(1).max(5_000),
  sourceIds: z.array(z.uuid()).min(1).max(20),
  calculationId: z.uuid().nullable().default(null),
  supportMode: z.enum(['DIRECT', 'CALCULATED', 'SEMANTIC']),
});
/** 结构化 Claim 类型。 */
export type AnswerClaim = z.infer<typeof AnswerClaimSchema>;

/** LLM 唯一允许生成的答案草稿。 */
export const AnswerDraftSchema = z.object({
  summary: z.string().trim().min(1).max(20_000),
  claims: z.array(AnswerClaimSchema).max(100),
  caveats: z.array(z.string().trim().min(1).max(2_000)).max(50),
  followUpQuestion: z.string().trim().min(1).max(2_000).nullable(),
});
/** 结构化答案草稿类型。 */
export type AnswerDraft = z.infer<typeof AnswerDraftSchema>;

/** 确定性或语义校验发现的问题。 */
export const ValidationIssueSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,99}$/),
  severity: z.enum(['BLOCKING', 'REPAIRABLE', 'WARNING']),
  claimId: z.string().max(100).nullable(),
  description: z.string().min(1).max(500),
});
/** 校验问题类型。 */
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/** 语义 Judge 只能判断规则无法确定的 Claim，不得覆盖阻断项。 */
export const SemanticGroundingReportSchema = z.object({
  modelId: z.string().min(1).max(160),
  revision: z.string().min(1).max(100),
  reason: z.string().min(1).max(500),
  supportedClaimIds: z.array(z.string().max(100)).max(100),
  unsupportedClaimIds: z.array(z.string().max(100)).max(100),
});
/** 语义 Grounding 报告类型。 */
export type SemanticGroundingReport = z.infer<typeof SemanticGroundingReportSchema>;

/** Validator 的不可变结论。 */
export const ValidationReportSchema = z.object({
  outcome: z.enum(['PASS', 'REGENERATE', 'PARTIAL', 'REJECT']),
  issues: z.array(ValidationIssueSchema).max(500),
  checkedClaimCount: z.number().int().nonnegative(),
  validSourceIds: z.array(z.uuid()).max(100),
  validatorProfileId: z.string().min(1).max(100),
  semanticJudge: SemanticGroundingReportSchema.nullable(),
});
/** 答案校验报告类型。 */
export type ValidationReport = z.infer<typeof ValidationReportSchema>;

/** 用户可见的最终答案状态。 */
export const FinalAnswerStatusSchema = z.enum([
  'ANSWERED',
  'PARTIAL',
  'CLARIFICATION',
  'CONFLICT',
  'REJECTED',
]);
/** 最终答案状态类型。 */
export type FinalAnswerStatus = z.infer<typeof FinalAnswerStatusSchema>;

/** 校验通过后才允许持久化和发送给客户端的最终答案。 */
export const FinalAnswerSchema = z.object({
  status: FinalAnswerStatusSchema,
  summary: z.string().trim().min(1).max(20_000),
  claims: z.array(AnswerClaimSchema).max(100),
  caveats: z.array(z.string().trim().min(1).max(2_000)).max(50),
  followUpQuestion: z.string().trim().min(1).max(2_000).nullable(),
  citations: z.array(z.uuid()).max(100),
  validation: ValidationReportSchema,
});
/** 最终答案类型。 */
export type FinalAnswer = z.infer<typeof FinalAnswerSchema>;

/** 引用预览每次读取都重新鉴权，只返回最小必要正文和定位。 */
export const CitationPreviewSchema = z.object({
  citationId: z.uuid(),
  title: z.string().min(1).max(240),
  headingPath: z.array(z.string().max(500)).max(100),
  excerpt: z.string().min(1).max(2_000),
  sourceLocations: z.array(z.unknown()).max(10_000),
  publishedAt: TimestampSchema,
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.nullable(),
});
/** 引用预览类型。 */
export type CitationPreview = z.infer<typeof CitationPreviewSchema>;

/** 最终答案 API Envelope。 */
export const FinalAnswerEnvelopeSchema = createApiEnvelopeSchema(FinalAnswerSchema);
/** 引用预览 API Envelope。 */
export const CitationPreviewEnvelopeSchema = createApiEnvelopeSchema(CitationPreviewSchema);
