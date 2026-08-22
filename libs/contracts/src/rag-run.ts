/**
 * M06 会话、消息、RAG Run、Graph Step 与顺序事件的跨进程契约。
 *
 * HTTP、PostgreSQL、Redis Stream 和后续 M07/M08 Graph 执行器共享这些 Zod Schema。
 * 本文件只描述稳定数据形状，不实现认证、加密、状态迁移或事件发布。
 *
 * @requirement RUN-001
 * @requirement RUN-003
 * @requirement RUN-004
 * @requirement RUN-006
 * @requirement RUN-007
 * @requirement RUN-013
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';

const TimestampSchema = z.iso.datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** 会话生命周期；归档后只读，不能继续创建 Run。 */
export const ConversationStatusSchema = z.enum(['ACTIVE', 'ARCHIVED']);
/** 会话生命周期 TypeScript 类型。 */
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

/** 一条企业问答会话。 */
export const ConversationSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(200),
  status: ConversationStatusSchema,
  optimisticVersion: z.number().int().nonnegative(),
  lastMessageAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
/** 会话公共视图，不暴露 ownerUserId。 */
export type Conversation = z.infer<typeof ConversationSchema>;

/** 会话消息角色。 */
export const ConversationMessageRoleSchema = z.enum(['USER', 'ASSISTANT', 'SYSTEM']);
/** 会话消息角色 TypeScript 类型。 */
export type ConversationMessageRole = z.infer<typeof ConversationMessageRoleSchema>;

/** 正文在 PostgreSQL 中的合规保存方式。 */
export const SensitiveContentStorageSchema = z.enum(['AES_256_GCM', 'REDACTED', 'PLAIN']);
/** 正文合规保存方式 TypeScript 类型。 */
export type SensitiveContentStorage = z.infer<typeof SensitiveContentStorageSchema>;

/** 消息可见性状态；PENDING 的助手消息不能被当成最终答案。 */
export const ConversationMessageStatusSchema = z.enum([
  'PENDING',
  'VISIBLE',
  'REDACTED',
  'DELETED',
]);
/** 消息状态 TypeScript 类型。 */
export type ConversationMessageStatus = z.infer<typeof ConversationMessageStatusSchema>;

/** 会话消息公共视图；content 已由合规保护器解密或替换为脱敏占位。 */
export const ConversationMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  runId: z.uuid().nullable(),
  role: ConversationMessageRoleSchema,
  status: ConversationMessageStatusSchema,
  content: z.string().max(200_000).nullable(),
  contentStoredAs: SensitiveContentStorageSchema,
  contentSha256: Sha256Schema,
  citationsSummary: z.record(z.string(), z.unknown()).nullable(),
  createdAt: TimestampSchema,
});
/** 会话消息 TypeScript 类型。 */
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

/** 会话短期状态，只保存摘要、确认实体和最近引用标识。 */
export const ConversationStateSchema = z.object({
  conversationId: z.uuid(),
  optimisticVersion: z.number().int().nonnegative(),
  summary: z.string().max(20_000).nullable(),
  confirmedEntities: z.array(z.string().min(1).max(200)).max(200),
  recentCitationIds: z.array(z.uuid()).max(100),
  shortWindowMessageIds: z.array(z.uuid()).max(100),
  updatedAt: TimestampSchema,
});
/** 会话短期状态 TypeScript 类型。 */
export type ConversationState = z.infer<typeof ConversationStateSchema>;

/** Graph 写入有限会话记忆的运行时契约；来源空间用于后续重新鉴权。 */
export const SaveConversationStateInputSchema = z.object({
  summary: z.string().max(20_000).nullable(),
  summarySourceSpaceIds: z.array(z.uuid()).max(50),
  confirmedEntities: z.array(z.string().min(1).max(200)).max(200),
  recentCitationIds: z.array(z.uuid()).max(100),
});
/** Graph 写入有限会话记忆的 TypeScript 类型。 */
export type SaveConversationStateInput = z.infer<typeof SaveConversationStateInputSchema>;

/** Run 生命周期；终态不可逆。 */
export const RagRunStatusSchema = z.enum([
  'ACCEPTED',
  'RUNNING',
  'CANCELLING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);
/** Run 生命周期 TypeScript 类型。 */
export type RagRunStatus = z.infer<typeof RagRunStatusSchema>;

/** 一个空间在 Run 创建时锁定的可见 Manifest 与 Embedding 事实。 */
export const RunManifestSnapshotSchema = z.object({
  spaceId: z.uuid(),
  manifestId: z.uuid(),
  manifestVersion: z.number().int().positive(),
  embeddingProfileId: z.string().min(1).max(100),
  embeddingModelRevision: z.string().min(1).max(100),
  collectionName: z.string().min(1).max(255),
  authzPolicyVersion: z.number().int().nonnegative(),
});
/** 空间发布快照 TypeScript 类型。 */
export type RunManifestSnapshot = z.infer<typeof RunManifestSnapshotSchema>;

/** Run 创建时冻结的全部流程和 Provider 版本。 */
export const RagRunSnapshotSchema = z.object({
  flowVersion: z.string().min(1).max(100),
  policyVersion: z.string().min(1).max(100),
  promptProfileId: z.string().min(1).max(100),
  embeddingProfileId: z.string().min(1).max(100),
  embeddingRevision: z.string().min(1).max(100),
  rerankerProfileId: z.string().min(1).max(100),
  rerankerRevision: z.string().min(1).max(100),
  llmProfileId: z.string().min(1).max(100),
  llmRevision: z.string().min(1).max(100),
  validatorProfileId: z.string().min(1).max(100),
  manifests: z.array(RunManifestSnapshotSchema).min(1).max(50),
  authzVersion: z.number().int().nonnegative(),
  rolesSha256: Sha256Schema,
});
/** Run 冻结快照 TypeScript 类型。 */
export type RagRunSnapshot = z.infer<typeof RagRunSnapshotSchema>;

/** 可持久化且可重放的问答 Run。 */
export const RagRunSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  userMessageId: z.uuid(),
  assistantMessageId: z.uuid().nullable(),
  status: RagRunStatusSchema,
  optimisticVersion: z.number().int().nonnegative(),
  snapshot: RagRunSnapshotSchema,
  deadlineAt: TimestampSchema,
  eventExpiresAt: TimestampSchema,
  cancelRequestedAt: TimestampSchema.nullable(),
  failureCode: z.string().max(100).nullable(),
  publicMessage: z.string().max(500),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
});
/** 问答 Run TypeScript 类型。 */
export type RagRun = z.infer<typeof RagRunSchema>;

/** Graph 节点执行状态。 */
export const RagRunStepStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'SKIPPED',
]);
/** Graph 节点执行状态 TypeScript 类型。 */
export type RagRunStepStatus = z.infer<typeof RagRunStepStatusSchema>;

/** Graph 节点审计记录只保存摘要、计数和稳定错误，不保存问题或证据全文。 */
export const RagRunStepSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  nodeKey: z.string().min(1).max(100),
  attempt: z.number().int().positive(),
  status: RagRunStepStatusSchema,
  inputSummary: z.record(z.string(), z.unknown()),
  outputSummary: z.record(z.string(), z.unknown()),
  durationMs: z.number().int().nonnegative().nullable(),
  errorCode: z.string().max(100).nullable(),
  errorMessage: z.string().max(500).nullable(),
  traceId: z.string().max(64).nullable(),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
});
/** Graph 节点审计记录 TypeScript 类型。 */
export type RagRunStep = z.infer<typeof RagRunStepSchema>;

/** Redis Stream 中的顺序事件；sequence 在单个 Run 内严格递增。 */
export const RagRunEventSchema = z.object({
  eventId: z.uuid(),
  runId: z.uuid(),
  sequence: z.number().int().positive(),
  schemaVersion: z.literal(1),
  eventType: z.string().regex(/^[a-z][a-z0-9_.-]{1,99}$/),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: TimestampSchema,
});
/** Run 顺序事件 TypeScript 类型。 */
export type RagRunEvent = z.infer<typeof RagRunEventSchema>;

/** 新建会话请求。 */
export const CreateConversationRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});
/** 新建会话请求 TypeScript 类型。 */
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

/** 会话列表游标查询。 */
export const ListConversationsQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
/** 会话列表查询 TypeScript 类型。 */
export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;

/** 创建异步 Run 的请求；请求空间只能缩小服务端授权范围。 */
export const CreateRagRunRequestSchema = z.object({
  question: z.string().trim().min(1).max(20_000),
  requestedSpaceIds: z.array(z.uuid()).min(1).max(50),
});
/** 创建异步 Run 请求 TypeScript 类型。 */
export type CreateRagRunRequest = z.infer<typeof CreateRagRunRequestSchema>;

/** 快速创建 Run 的 202 响应。 */
export const CreateRagRunAcceptedSchema = z.object({
  run: RagRunSchema,
  eventsUrl: z.string().min(1).max(500),
  ticketUrl: z.string().min(1).max(500),
  expiresAt: TimestampSchema,
  replayed: z.boolean(),
});
/** 快速创建 Run 响应 TypeScript 类型。 */
export type CreateRagRunAccepted = z.infer<typeof CreateRagRunAcceptedSchema>;

/** Run 取消请求，原因进入审计而不是模型上下文。 */
export const CancelRagRunRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
/** Run 取消请求 TypeScript 类型。 */
export type CancelRagRunRequest = z.infer<typeof CancelRagRunRequestSchema>;

/** 一次性 SSE Ticket 响应；Ticket 本身不得写入日志。 */
export const RunStreamTicketSchema = z.object({
  ticket: z.string().min(32).max(256),
  streamUrl: z.string().min(1).max(500),
  expiresAt: TimestampSchema,
});
/** 一次性 SSE Ticket TypeScript 类型。 */
export type RunStreamTicket = z.infer<typeof RunStreamTicketSchema>;

/** Stream 过期后轮询接口同时返回 PG Run 快照作为降级事实。 */
export const RagRunEventPageSchema = z.object({
  items: z.array(RagRunEventSchema),
  nextSequence: z.number().int().nonnegative(),
  streamExpired: z.boolean(),
  run: RagRunSchema,
});
/** Run 事件轮询页 TypeScript 类型。 */
export type RagRunEventPage = z.infer<typeof RagRunEventPageSchema>;

/** 用户对最终助手消息的反馈。 */
export const CreateMessageFeedbackRequestSchema = z.object({
  rating: z.enum(['HELPFUL', 'NOT_HELPFUL']),
  reason: z.string().trim().max(1_000).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
});
/** 消息反馈请求 TypeScript 类型。 */
export type CreateMessageFeedbackRequest = z.infer<typeof CreateMessageFeedbackRequestSchema>;

/** 已保存的消息反馈。 */
export const MessageFeedbackSchema = CreateMessageFeedbackRequestSchema.extend({
  id: z.uuid(),
  messageId: z.uuid(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
/** 消息反馈 TypeScript 类型。 */
export type MessageFeedback = z.infer<typeof MessageFeedbackSchema>;

/** 会话 API Envelope。 */
export const ConversationEnvelopeSchema = createApiEnvelopeSchema(ConversationSchema);
/** 会话列表 API Envelope。 */
export const ConversationListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(ConversationSchema), nextCursor: z.string().nullable() }),
);
/** 消息列表 API Envelope。 */
export const ConversationMessageListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(ConversationMessageSchema), state: ConversationStateSchema }),
);
/** Run 快速创建 API Envelope。 */
export const CreateRagRunAcceptedEnvelopeSchema = createApiEnvelopeSchema(
  CreateRagRunAcceptedSchema,
);
/** Run 详情 API Envelope。 */
export const RagRunEnvelopeSchema = createApiEnvelopeSchema(RagRunSchema);
/** Run Step 列表 API Envelope。 */
export const RagRunStepListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(RagRunStepSchema) }),
);
/** Run 事件轮询 API Envelope。 */
export const RagRunEventPageEnvelopeSchema = createApiEnvelopeSchema(RagRunEventPageSchema);
/** SSE Ticket API Envelope。 */
export const RunStreamTicketEnvelopeSchema = createApiEnvelopeSchema(RunStreamTicketSchema);
/** 消息反馈 API Envelope。 */
export const MessageFeedbackEnvelopeSchema = createApiEnvelopeSchema(MessageFeedbackSchema);
