/**
 * 查询规划与混合检索 查询规划、混合检索、来源复核与授权调试的跨层契约。
 *
 * 这些 Schema 是 HTTP、LangGraph、Application 与 Adapter 共享的数据边界。
 * Filter 只允许表达平台定义的结构化约束，不提供 SQL 或 Milvus 表达式字段，
 * 从类型层阻止浏览器、LLM 和普通业务代码把任意查询语言带入基础设施。
 *
 * @requirement RET-001
 * @requirement RET-006
 * @requirement RET-007
 * @requirement RET-016
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';
import { SparseVectorSchema } from './indexing';

const TimestampSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** 确定性入口路由；只有 KNOWLEDGE 会进入知识检索。 */
export const RetrievalRouteSchema = z.enum(['CHAT', 'KNOWLEDGE', 'CLARIFY', 'REJECT']);
/** 查询入口路由类型。 */
export type RetrievalRoute = z.infer<typeof RetrievalRouteSchema>;

/** 必须在改写后原样保留的精确字面量类别。 */
export const ExactLiteralKindSchema = z.enum([
  'AMOUNT',
  'DATE',
  'VERSION',
  'CODE',
  'NAME',
  'REGION',
]);
/** 精确字面量类别。 */
export type ExactLiteralKind = z.infer<typeof ExactLiteralKindSchema>;

/** 原问题中一个不可静默丢失或替换的精确字面量。 */
export const ExactLiteralSchema = z.object({
  kind: ExactLiteralKindSchema,
  value: z.string().min(1).max(200),
  normalizedValue: z.string().min(1).max(200),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
/** 精确字面量值对象。 */
export type ExactLiteral = z.infer<typeof ExactLiteralSchema>;

/** 服务端 FilterCompiler 唯一允许使用的来源字段。 */
export const RetrievalFilterFieldSchema = z.enum([
  'SPACE_ID',
  'MANIFEST_ID',
  'DOCUMENT_STATUS',
  'MANIFEST_STATUS',
  'PUBLISHED_AT',
  'EFFECTIVE_FROM',
  'EFFECTIVE_TO',
]);
/** Filter 白名单字段。 */
export type RetrievalFilterField = z.infer<typeof RetrievalFilterFieldSchema>;

/** 服务端 FilterCompiler 唯一允许使用的操作符。 */
export const RetrievalFilterOperatorSchema = z.enum([
  'EQ',
  'IN',
  'LTE',
  'GT',
  'IS_NULL',
  'NULL_OR_GT',
]);
/** Filter 白名单操作符。 */
export type RetrievalFilterOperator = z.infer<typeof RetrievalFilterOperatorSchema>;

/** 一条结构化过滤子句；值只作为参数，不是数据库表达式片段。 */
export const RetrievalFilterClauseSchema = z.object({
  field: RetrievalFilterFieldSchema,
  operator: RetrievalFilterOperatorSchema,
  value: z.union([z.string().max(500), z.array(z.string().max(500)).max(50), z.null()]),
});
/** 结构化过滤子句。 */
export type RetrievalFilterClause = z.infer<typeof RetrievalFilterClauseSchema>;

/** FilterCompiler 产物，绑定运行快照和检索时点。 */
export const RetrievalFilterSchema = z.object({
  clauses: z.array(RetrievalFilterClauseSchema).min(1).max(200),
  asOf: TimestampSchema,
  compilerVersion: z.string().min(1).max(100),
  requireManifestMembership: z.literal(true),
  requireCurrentDocumentVersion: z.literal(true),
});
/** 安全过滤计划。 */
export type RetrievalFilter = z.infer<typeof RetrievalFilterSchema>;

/** 一次 Run 冻结的检索算法参数；配置变化不会改变在途 Run。 */
export const RetrievalProfileSnapshotSchema = z
  .object({
    profileId: z.string().min(1).max(100),
    initialTopK: z.number().int().min(1).max(100),
    finalTopK: z.number().int().min(1).max(50),
    rrfK: z.number().int().min(1).max(10_000),
    denseWeight: z.number().finite().min(0).max(10),
    sparseWeight: z.number().finite().min(0).max(10),
    maxPerDocument: z.number().int().min(1).max(20),
    maxPerSection: z.number().int().min(1).max(20),
    minimumResults: z.number().int().min(1).max(20),
    maxRounds: z.literal(2),
  })
  .superRefine((profile, context) => {
    if (profile.finalTopK > profile.initialTopK) {
      context.addIssue({
        code: 'custom',
        path: ['finalTopK'],
        message: '最终 TopK 不能大于初始 TopK',
      });
    }
    if (profile.denseWeight + profile.sparseWeight <= 0) {
      context.addIssue({
        code: 'custom',
        path: ['denseWeight'],
        message: 'Dense 与 Sparse 权重不能同时为 0',
      });
    }
    if (profile.minimumResults > profile.initialTopK) {
      context.addIssue({
        code: 'custom',
        path: ['minimumResults'],
        message: '最低结果数不能大于初始 TopK',
      });
    }
  });
/** 冻结检索参数类型。 */
export type RetrievalProfileSnapshot = z.infer<typeof RetrievalProfileSnapshotSchema>;

/** 历史与当前问题中的已确认实体；当前问题在同类冲突时优先。 */
export const RetrievalEntitySchema = z.object({
  kind: ExactLiteralKindSchema,
  value: z.string().min(1).max(200),
  source: z.enum(['CURRENT', 'HISTORY']),
});
/** 查询实体类型。 */
export type RetrievalEntity = z.infer<typeof RetrievalEntitySchema>;

/** LLM 允许返回的唯一改写形状；没有 Filter、SQL、Milvus expression 或权限字段。 */
export const QueryRewriteSuggestionSchema = z.object({
  rewrittenQuery: z.string().trim().min(1).max(8_000),
  subQuestions: z.array(z.string().trim().min(1).max(2_000)).max(4),
  entities: z
    .array(
      z.object({
        kind: ExactLiteralKindSchema,
        value: z.string().trim().min(1).max(200),
      }),
    )
    .max(100),
});
/** 经运行时校验的 LLM 改写建议。 */
export type QueryRewriteSuggestion = z.infer<typeof QueryRewriteSuggestionSchema>;

/** 查询规划与混合检索 受控查询计划；最多四个子问题且只接受编译后的 Filter。 */
export const RetrievalPlanSchema = z.object({
  route: RetrievalRouteSchema,
  source: z.enum(['DETERMINISTIC', 'LLM_ASSISTED']),
  primaryQuery: z.string().min(1).max(8_000),
  subQuestions: z.array(z.string().min(1).max(2_000)).min(1).max(4),
  exactLiterals: z.array(ExactLiteralSchema).max(100),
  entities: z.array(RetrievalEntitySchema).max(100),
  filter: RetrievalFilterSchema,
  round: z.number().int().min(1).max(2),
  profile: RetrievalProfileSnapshotSchema,
  planSha256: Sha256Schema,
});
/** 查询计划类型。 */
export type RetrievalPlan = z.infer<typeof RetrievalPlanSchema>;

/** 向量检索的最小命中事实，不包含 Chunk 正文。 */
export const RetrievalVectorHitSchema = z.object({
  vectorId: Sha256Schema,
  manifestId: z.uuid(),
  spaceId: z.uuid(),
  documentId: z.uuid(),
  score: z.number().finite(),
  route: z.enum(['DENSE', 'SPARSE']),
  rank: z.number().int().positive(),
});
/** 向量检索命中类型。 */
export type RetrievalVectorHit = z.infer<typeof RetrievalVectorHitSchema>;

/** RRF 融合后、PG 回源前的候选。 */
export const FusedRetrievalCandidateSchema = z.object({
  vectorId: Sha256Schema,
  manifestId: z.uuid(),
  spaceId: z.uuid(),
  documentId: z.uuid(),
  denseRank: z.number().int().positive().nullable(),
  sparseRank: z.number().int().positive().nullable(),
  denseScore: z.number().finite().nullable(),
  sparseScore: z.number().finite().nullable(),
  rrfScore: z.number().finite().nonnegative(),
});
/** 融合候选类型。 */
export type FusedRetrievalCandidate = z.infer<typeof FusedRetrievalCandidateSchema>;

/** PostgreSQL 复核通过后的完整检索候选；正文永远不从 Milvus 返回。 */
export const RetrievalCandidateSchema = FusedRetrievalCandidateSchema.extend({
  chunkId: z.string().min(1).max(180),
  documentVersionId: z.uuid(),
  contentRevision: z.number().int().positive(),
  ordinal: z.number().int().positive(),
  title: z.string().min(1).max(240),
  headingPath: z.array(z.string().max(500)).max(100),
  displayContent: z.string().min(1),
  sourceLocations: z.array(z.unknown()),
  publishedAt: TimestampSchema,
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.nullable(),
});
/** 已授权、可供 证据与答案生成 Reranker/生成使用的候选。 */
export type RetrievalCandidate = z.infer<typeof RetrievalCandidateSchema>;

/** 查询 Embedding 的缓存值；必须同时保存锁定模型事实。 */
export const QueryEmbeddingCacheValueSchema = z.object({
  dense: z.array(z.number().finite()).min(1).max(65_536),
  sparse: SparseVectorSchema.nullable(),
  modelId: z.string().min(1).max(160),
  revision: z.string().min(1).max(100),
});
/** 查询 Embedding 缓存值类型。 */
export type QueryEmbeddingCacheValue = z.infer<typeof QueryEmbeddingCacheValueSchema>;

/** 单条召回路线的执行摘要，用于安全降级与调试。 */
export const RetrievalRouteSummarySchema = z.object({
  route: z.enum(['DENSE', 'SPARSE']),
  status: z.enum(['SUCCEEDED', 'DEGRADED', 'UNAVAILABLE']),
  hitCount: z.number().int().nonnegative(),
  errorCode: z.string().max(100).nullable(),
});
/** 召回路线摘要类型。 */
export type RetrievalRouteSummary = z.infer<typeof RetrievalRouteSummarySchema>;

/** 对管理员/审计员公开的候选摘要；不回传 Chunk 正文或问题原文。 */
export const RetrievalDebugCandidateSchema = z.object({
  rank: z.number().int().positive(),
  vectorId: Sha256Schema,
  spaceId: z.uuid(),
  documentId: z.uuid(),
  documentVersionId: z.uuid(),
  chunkId: z.string().min(1).max(180),
  title: z.string().min(1).max(240),
  headingPath: z.array(z.string().max(500)).max(100),
  denseRank: z.number().int().positive().nullable(),
  sparseRank: z.number().int().positive().nullable(),
  rrfScore: z.number().finite().nonnegative(),
});
/** 调试候选类型。 */
export type RetrievalDebugCandidate = z.infer<typeof RetrievalDebugCandidateSchema>;

/** 查询规划与混合检索 授权调试响应；只给计划和来源摘要，不暴露敏感正文。 */
export const RetrievalDebugResultSchema = z.object({
  runId: z.uuid(),
  route: RetrievalRouteSchema,
  planSha256: Sha256Schema,
  planSource: z.enum(['DETERMINISTIC', 'LLM_ASSISTED']),
  roundCount: z.number().int().min(0).max(2),
  subQuestionCount: z.number().int().min(0).max(4),
  exactLiteralKinds: z.array(ExactLiteralKindSchema),
  cacheHit: z.boolean(),
  degraded: z.boolean(),
  routes: z.array(RetrievalRouteSummarySchema).max(4),
  removedByReason: z.record(z.string(), z.number().int().nonnegative()),
  candidates: z.array(RetrievalDebugCandidateSchema).max(50),
});
/** 查询规划与混合检索 调试结果类型。 */
export type RetrievalDebugResult = z.infer<typeof RetrievalDebugResultSchema>;

/** 查询规划与混合检索 调试响应信封。 */
export const RetrievalDebugEnvelopeSchema = createApiEnvelopeSchema(RetrievalDebugResultSchema);
