/**
 * 生产运维控制面的公共契约。
 *
 * 这些 Schema 只暴露聚合状态、稳定错误和非敏感 Provider 元数据；密钥、完整问题、
 * 预签名地址和隐藏候选永远不进入浏览器。具体探针、SQL、Redis 与告警渠道由 Adapter 实现。
 *
 * @requirement OPS-005
 * @requirement OPS-007
 * @requirement OPS-016
 * @requirement OPS-018
 * @requirement WEB-024
 * @requirement WEB-025
 * @requirement WEB-026
 * @requirement WEB-030
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';

/** 运维组件的公开健康状态。 */
export const OperationalHealthStatusSchema = z.enum(['UP', 'DEGRADED', 'DOWN', 'UNKNOWN']);
/** 运维组件健康状态。 */
export type OperationalHealthStatus = z.infer<typeof OperationalHealthStatusSchema>;

/** 单个依赖或运行面的非敏感健康摘要。 */
export const OperationalComponentSchema = z
  .object({
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    kind: z.enum([
      'API',
      'WORKER',
      'POSTGRES',
      'REDIS',
      'MINIO',
      'MILVUS',
      'MODEL',
      'QUEUE',
      'SSE',
    ]),
    status: OperationalHealthStatusSchema,
    latencyMs: z.number().int().nonnegative().nullable(),
    message: z.string().min(1).max(300),
    checkedAt: z.iso.datetime(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();
/** 组件健康摘要。 */
export type OperationalComponent = z.infer<typeof OperationalComponentSchema>;

/** 队列积压和卡住任务摘要。 */
export const QueueOperationalSummarySchema = z
  .object({
    queue: z.string().min(1).max(100),
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    dlq: z.number().int().nonnegative(),
    stalled: z.number().int().nonnegative(),
    oldestWaitingSeconds: z.number().int().nonnegative().nullable(),
  })
  .strict();
/** 队列摘要。 */
export type QueueOperationalSummary = z.infer<typeof QueueOperationalSummarySchema>;

/** 最近索引对账的公开摘要；问题正文留在受控事实表，不进入浏览器。 */
export const IndexReconciliationSummarySchema = z
  .object({
    id: z.uuid(),
    indexingRunId: z.uuid(),
    manifestId: z.uuid(),
    expectedCount: z.number().int().nonnegative(),
    actualCount: z.number().int().nonnegative(),
    checkedPrimaryKeys: z.number().int().nonnegative(),
    fixedQueriesPassed: z.number().int().nonnegative(),
    issueCount: z.number().int().nonnegative(),
    passed: z.boolean(),
    reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
  })
  .strict();
/** 索引对账公开摘要。 */
export type IndexReconciliationSummary = z.infer<typeof IndexReconciliationSummarySchema>;

/** 告警只包含可行动的脱敏信息和 Runbook 键。 */
export const OperationalAlertSchema = z
  .object({
    id: z.uuid(),
    severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
    code: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    publicMessage: z.string().min(1).max(500),
    resourceType: z.string().min(1).max(80),
    resourceId: z.string().max(180).nullable(),
    runbookKey: z.string().min(1).max(100),
    status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']),
    occurredAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
/** 运维告警。 */
export type OperationalAlert = z.infer<typeof OperationalAlertSchema>;

/** 告警确认/解决动作必须附带审计原因。 */
export const UpdateOperationalAlertRequestSchema = z
  .object({
    action: z.enum(['ACKNOWLEDGE', 'RESOLVE']),
    reason: z.string().min(2).max(500),
  })
  .strict();
/** 告警动作请求。 */
export type UpdateOperationalAlertRequest = z.infer<typeof UpdateOperationalAlertRequestSchema>;

/** 总览业务数量与最近质量趋势。 */
export const PlatformOverviewSchema = z
  .object({
    spaces: z.number().int().nonnegative(),
    documents: z.number().int().nonnegative(),
    jobsRunning: z.number().int().nonnegative(),
    jobsFailed: z.number().int().nonnegative(),
    pendingReviews: z.number().int().nonnegative(),
    publishedDocuments: z.number().int().nonnegative(),
    questions24h: z.number().int().nonnegative(),
    answerSuccessRate24h: z.number().min(0).max(1),
    qualityTrend: z.array(
      z
        .object({
          date: z.iso.date(),
          answerSuccessRate: z.number().min(0).max(1),
          citationPrecision: z.number().min(0).max(1).nullable(),
          runs: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
/** 平台总览。 */
export type PlatformOverview = z.infer<typeof PlatformOverviewSchema>;

/** Provider/Profile 只读公开视图。 */
export const ProviderProfileStatusSchema = z
  .object({
    capability: z.enum(['LLM', 'EMBEDDING', 'RERANKER', 'OCR', 'PARSER', 'VECTOR_STORE']),
    adapter: z.string().min(1).max(80),
    profileId: z.string().min(1).max(160),
    modelId: z.string().max(200).nullable(),
    revision: z.string().min(1).max(120),
    protocolVersion: z.string().min(1).max(80),
    endpointHost: z.string().min(1).max(240),
    credentialConfigured: z.boolean(),
    health: OperationalHealthStatusSchema,
    compatibilityMessage: z.string().min(1).max(300),
  })
  .strict();
/** Provider/Profile 状态。 */
export type ProviderProfileStatus = z.infer<typeof ProviderProfileStatusSchema>;

/** Feature Flag 的可灰度、可回退事实。 */
export const FeatureFlagSchema = z
  .object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),
    scope: z.enum(['SYSTEM', 'SPACE']),
    spaceId: z.uuid().nullable(),
    enabled: z.boolean(),
    rolloutPercent: z.number().int().min(0).max(100),
    version: z.number().int().positive(),
    reason: z.string().min(2).max(500),
    updatedBy: z.string().min(1),
    updatedAt: z.iso.datetime(),
  })
  .strict();
/** Feature Flag。 */
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

/** Run 快照中的最终 Flag 决策，包含版本以支持重放。 */
export const FeatureFlagDecisionSchema = z
  .object({
    key: z.string(),
    enabled: z.boolean(),
    version: z.number().int().positive(),
    scope: z.enum(['SYSTEM', 'SPACE']),
    spaceId: z.uuid().nullable(),
  })
  .strict();
/** Run Flag 决策。 */
export type FeatureFlagDecision = z.infer<typeof FeatureFlagDecisionSchema>;

/** 修改 Flag 必须携带乐观锁与审计原因。 */
export const UpdateFeatureFlagRequestSchema = z
  .object({
    enabled: z.boolean(),
    rolloutPercent: z.number().int().min(0).max(100),
    expectedVersion: z.number().int().positive(),
    reason: z.string().min(2).max(500),
  })
  .strict();
/** 修改 Flag 请求。 */
export type UpdateFeatureFlagRequest = z.infer<typeof UpdateFeatureFlagRequestSchema>;

/** 审计查询白名单；客户端不能提供 SQL 字段或排序表达式。 */
export const AuditLogQuerySchema = z
  .object({
    userId: z.string().min(1).max(160).optional(),
    role: z.string().min(1).max(80).optional(),
    action: z.string().min(1).max(120).optional(),
    resourceType: z.string().min(1).max(80).optional(),
    result: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
/** 审计查询。 */
export type AuditLogQuery = z.input<typeof AuditLogQuerySchema>;

/** 浏览器可见的脱敏审计记录。 */
export const AuditLogEntrySchema = z
  .object({
    id: z.uuid(),
    userId: z.string().min(1),
    roles: z.array(z.string()),
    action: z.string(),
    resourceType: z.string(),
    resourceId: z.string().nullable(),
    result: z.enum(['SUCCESS', 'DENIED', 'FAILURE']),
    reason: z.string().nullable(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    occurredAt: z.iso.datetime(),
  })
  .strict();
/** 审计记录。 */
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

/** 运维 Dashboard。 */
export const OperationsDashboardSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    overallStatus: OperationalHealthStatusSchema,
    components: z.array(OperationalComponentSchema),
    queues: z.array(QueueOperationalSummarySchema),
    reconciliations: z.array(IndexReconciliationSummarySchema),
    alerts: z.array(OperationalAlertSchema),
  })
  .strict();
/** 运维 Dashboard。 */
export type OperationsDashboard = z.infer<typeof OperationsDashboardSchema>;

/** 通用列表形状。 */
export const OperationalAlertListSchema = z
  .object({ items: z.array(OperationalAlertSchema) })
  .strict();
/** Provider 列表。 */
export const ProviderProfileStatusListSchema = z
  .object({ items: z.array(ProviderProfileStatusSchema) })
  .strict();
/** Flag 列表。 */
export const FeatureFlagListSchema = z.object({ items: z.array(FeatureFlagSchema) }).strict();
/** 审计游标页。 */
export const AuditLogPageSchema = z
  .object({ items: z.array(AuditLogEntrySchema), nextCursor: z.string().nullable() })
  .strict();

/** 平台总览统一响应。 */
export const PlatformOverviewEnvelopeSchema = createApiEnvelopeSchema(PlatformOverviewSchema);
/** 运维 Dashboard 统一响应。 */
export const OperationsDashboardEnvelopeSchema = createApiEnvelopeSchema(OperationsDashboardSchema);
/** 告警动作统一响应。 */
export const OperationalAlertEnvelopeSchema = createApiEnvelopeSchema(OperationalAlertSchema);
/** Provider/Profile 列表统一响应。 */
export const ProviderProfileStatusListEnvelopeSchema = createApiEnvelopeSchema(
  ProviderProfileStatusListSchema,
);
/** Feature Flag 列表统一响应。 */
export const FeatureFlagListEnvelopeSchema = createApiEnvelopeSchema(FeatureFlagListSchema);
/** 单个 Feature Flag 统一响应。 */
export const FeatureFlagEnvelopeSchema = createApiEnvelopeSchema(FeatureFlagSchema);
/** 审计日志游标页统一响应。 */
export const AuditLogPageEnvelopeSchema = createApiEnvelopeSchema(AuditLogPageSchema);
