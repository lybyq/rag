/**
 * M02 文档、上传会话、入库任务与事件的运行时契约。
 * 所有边界输入输出都由 Zod 校验，数据库行和浏览器响应也复用同一事实定义。
 *
 * @requirement DOC-001
 * @requirement DOC-003
 * @requirement DOC-011
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';

/** 文档业务状态；删除采用归档语义，避免破坏版本和审计链。 */
export const DocumentStatusSchema = z.enum(['ACTIVE', 'ARCHIVED']);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/** 文档版本从上传到可供下游发布的完整状态集合。 */
export const DocumentVersionStatusSchema = z.enum([
  'UPLOADING',
  'QUEUED',
  'PROCESSING',
  'WAITING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REJECTED',
]);
export type DocumentVersionStatus = z.infer<typeof DocumentVersionStatusSchema>;

/** 入库任务与步骤共享状态名称，便于任务中心统一渲染。 */
export const IngestionExecutionStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REJECTED',
]);
export type IngestionExecutionStatus = z.infer<typeof IngestionExecutionStatusSchema>;

/** M02 先冻结全流水线步骤名，后续模块只补处理器而不改任务标识。 */
export const IngestionStepNameSchema = z.enum([
  'SECURITY_SCAN',
  'PARSE',
  'OCR',
  'NORMALIZE',
  'CHUNK',
  'QUALITY_GATE',
  'EMBED',
  'INDEX',
  'VERIFY',
  'PUBLISH',
]);
export type IngestionStepName = z.infer<typeof IngestionStepNameSchema>;

/** 上传会话状态独立于文档处理状态。 */
export const UploadSessionStatusSchema = z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED']);
export type UploadSessionStatus = z.infer<typeof UploadSessionStatusSchema>;

/** 单 PUT 与 Multipart 两种上传策略。 */
export const UploadStrategySchema = z.enum(['SINGLE', 'MULTIPART']);
export type UploadStrategy = z.infer<typeof UploadStrategySchema>;

/** ISO 时间统一要求带时区，防止内外网部署时产生本地时区歧义。 */
const TimestampSchema = z.iso.datetime({ offset: true });

/** 对象存储允许校验的摘要格式；SHA-256 始终使用小写十六进制。 */
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** 文档聚合根；version 是元数据乐观锁，latestVersionNumber 是业务版本号。 */
export const DocumentSchema = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  title: z.string().trim().min(1).max(240),
  status: DocumentStatusSchema,
  latestVersionNumber: z.number().int().positive(),
  version: z.number().int().positive(),
  createdBy: z.string().min(1).max(128),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Document = z.infer<typeof DocumentSchema>;

/** 文档版本保存不可覆盖的内容修订号及状态机版本。 */
export const DocumentVersionSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  versionNumber: z.number().int().positive(),
  contentRevision: z.number().int().positive(),
  status: DocumentVersionStatusSchema,
  optimisticVersion: z.number().int().positive(),
  createdBy: z.string().min(1).max(128),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

/** 原始文件事实；原始名仅是净化后的元数据，objectKey 由服务端随机标识构造。 */
export const DocumentFileSchema = z.object({
  id: z.uuid(),
  documentVersionId: z.uuid(),
  originalFileName: z.string().min(1).max(240),
  bucket: z.string().min(3).max(63),
  objectKey: z.string().min(1).max(1024),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(160),
  etag: z.string().min(1).max(160).nullable(),
  sha256: Sha256Schema.nullable(),
  createdAt: TimestampSchema,
});
export type DocumentFile = z.infer<typeof DocumentFileSchema>;

/** 步骤进度允许 totalUnits/stagePercent 为 null，明确表示总量未知。 */
export const IngestionJobStepSchema = z.object({
  id: z.string().min(1).max(300),
  jobId: z.string().min(1).max(300),
  name: IngestionStepNameSchema,
  stepVersion: z.number().int().positive(),
  status: IngestionExecutionStatusSchema,
  weightPercent: z.number().min(0).max(100),
  processedUnits: z.number().int().nonnegative(),
  totalUnits: z.number().int().positive().nullable(),
  stagePercent: z.number().min(0).max(100).nullable(),
  overallPercent: z.number().min(0).max(100),
  publicMessage: z.string().max(500).nullable(),
  attempt: z.number().int().positive(),
  startedAt: TimestampSchema.nullable(),
  heartbeatAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type IngestionJobStep = z.infer<typeof IngestionJobStepSchema>;

/** 入库任务详情包含步骤快照，lease 字段用于判断 worker 是否卡住。 */
export const IngestionJobSchema = z.object({
  id: z.string().min(1).max(300),
  documentId: z.uuid(),
  documentVersionId: z.uuid(),
  contentRevision: z.number().int().positive(),
  pipelineVersion: z.number().int().positive(),
  status: IngestionExecutionStatusSchema,
  currentStep: IngestionStepNameSchema.nullable(),
  overallPercent: z.number().min(0).max(100),
  publicMessage: z.string().max(500).nullable(),
  attempt: z.number().int().positive(),
  leaseOwner: z.string().max(128).nullable(),
  leaseExpiresAt: TimestampSchema.nullable(),
  heartbeatAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  steps: z.array(IngestionJobStepSchema),
});
export type IngestionJob = z.infer<typeof IngestionJobSchema>;

/** 上传前浏览器只提交文件描述，不把文件字节发给 Platform API。 */
export const UploadFileDescriptorSchema = z.object({
  clientFileId: z.string().trim().min(1).max(100),
  originalFileName: z.string().trim().min(1).max(512),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().trim().min(1).max(160),
  sha256: Sha256Schema.optional(),
});
export type UploadFileDescriptor = z.infer<typeof UploadFileDescriptorSchema>;

/** 创建会话最多 100 个文件；部署配置可在应用层进一步收紧。 */
export const CreateUploadSessionRequestSchema = z.object({
  spaceId: z.uuid(),
  files: z.array(UploadFileDescriptorSchema).min(1).max(100),
});
export type CreateUploadSessionRequest = z.infer<typeof CreateUploadSessionRequestSchema>;

/** 空间资源式上传入口从路径取得 spaceId，Body 只包含文件描述。 */
export const CreateSpaceDocumentUploadRequestSchema = CreateUploadSessionRequestSchema.pick({
  files: true,
});
export type CreateSpaceDocumentUploadRequest = z.infer<
  typeof CreateSpaceDocumentUploadRequestSchema
>;

/** 单个待上传文件的服务端计划。URL 仅短时有效，不是持久化凭证。 */
export const UploadFilePlanSchema = z.object({
  fileId: z.uuid(),
  clientFileId: z.string().min(1),
  originalFileName: z.string().min(1).max(240),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().min(1).max(160),
  strategy: UploadStrategySchema,
  partSizeBytes: z.number().int().positive(),
  partCount: z.number().int().positive(),
  uploadUrl: z.url().nullable(),
  expiresAt: TimestampSchema,
  completed: z.boolean(),
});
export type UploadFilePlan = z.infer<typeof UploadFilePlanSchema>;

/** 上传会话详情可在刷新后恢复；不会返回 bucket/objectKey 或 multipart uploadId。 */
export const UploadSessionSchema = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  status: UploadSessionStatusSchema,
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
  files: z.array(UploadFilePlanSchema),
});
export type UploadSession = z.infer<typeof UploadSessionSchema>;

/** 浏览器按需申请分片 URL；失败时只需重试对应 partNumber。 */
export const CreateUploadPartsRequestSchema = z.object({
  fileId: z.uuid(),
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
});
export type CreateUploadPartsRequest = z.infer<typeof CreateUploadPartsRequestSchema>;

/** 一条分片上传指令。 */
export const UploadPartInstructionSchema = z.object({
  partNumber: z.number().int().positive(),
  uploadUrl: z.url(),
  expiresAt: TimestampSchema,
});
export type UploadPartInstruction = z.infer<typeof UploadPartInstructionSchema>;

/** Multipart 完成时必须提交 MinIO 返回的 ETag，服务端据此合并。 */
export const CompletedUploadPartSchema = z.object({
  partNumber: z.number().int().positive(),
  etag: z.string().trim().min(1).max(160),
});
export type CompletedUploadPart = z.infer<typeof CompletedUploadPartSchema>;

/** 每次完成一个文件；重复提交同一个 fileId 必须返回同一组业务事实。 */
export const CompleteUploadRequestSchema = z.object({
  fileId: z.uuid(),
  parts: z.array(CompletedUploadPartSchema).max(10_000).default([]),
  sha256: Sha256Schema.optional(),
});
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequestSchema>;

/** 完成结果把后续查询所需的稳定标识一次返回。 */
export const CompleteUploadResultSchema = z.object({
  uploadSession: UploadSessionSchema,
  document: DocumentSchema,
  documentVersion: DocumentVersionSchema,
  file: DocumentFileSchema,
  job: IngestionJobSchema,
});
export type CompleteUploadResult = z.infer<typeof CompleteUploadResultSchema>;

/** 重处理不覆盖旧修订，并要求调用者说明原因。 */
export const ReprocessDocumentVersionRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(2).max(300),
});
export type ReprocessDocumentVersionRequest = z.infer<typeof ReprocessDocumentVersionRequestSchema>;

/** 取消会进入审计，原因不能省略。 */
export const CancelIngestionJobRequestSchema = z.object({
  reason: z.string().trim().min(2).max(300),
});
export type CancelIngestionJobRequest = z.infer<typeof CancelIngestionJobRequestSchema>;

/** 文档列表使用稳定游标分页，并支持空间、状态、文件名和关键词过滤。 */
export const ListDocumentsQuerySchema = z.object({
  spaceId: z.uuid().optional(),
  status: DocumentStatusSchema.optional(),
  search: z.string().trim().max(100).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuerySchema>;

/** 任务列表的筛选和游标分页契约。 */
export const ListIngestionJobsQuerySchema = z.object({
  spaceId: z.uuid().optional(),
  status: IngestionExecutionStatusSchema.optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListIngestionJobsQuery = z.infer<typeof ListIngestionJobsQuerySchema>;

/** 列表响应的游标元数据。 */
export const CursorPageSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type CursorPage = z.infer<typeof CursorPageSchema>;

/** 任务事件既供 SSE，也供 ETag/游标轮询。 */
export const IngestionJobEventSchema = z.object({
  id: z.number().int().positive(),
  jobId: z.string().min(1),
  eventType: z.string().min(1).max(100),
  data: z.record(z.string(), z.unknown()),
  occurredAt: TimestampSchema,
});
export type IngestionJobEvent = z.infer<typeof IngestionJobEventSchema>;

/** Outbox 契约固定聚合标识、事件类型、载荷及发布重试事实。 */
export const OutboxEventSchema = z.object({
  id: z.uuid(),
  aggregateType: z.string().min(1).max(80),
  aggregateId: z.string().min(1).max(300),
  eventType: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: TimestampSchema,
  publishedAt: TimestampSchema.nullable(),
  attempts: z.number().int().nonnegative(),
});
export type OutboxEvent = z.infer<typeof OutboxEventSchema>;

/** M02 HTTP 成功响应信封。 */
export const UploadSessionEnvelopeSchema = createApiEnvelopeSchema(UploadSessionSchema);
export const UploadPartListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(UploadPartInstructionSchema) }),
);
export const CompleteUploadEnvelopeSchema = createApiEnvelopeSchema(CompleteUploadResultSchema);
export const DocumentEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ document: DocumentSchema, versions: z.array(DocumentVersionSchema) }),
);
export const DocumentVersionEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ version: DocumentVersionSchema, files: z.array(DocumentFileSchema) }),
);
export const DocumentListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(DocumentSchema), page: CursorPageSchema }),
);
export const IngestionJobEnvelopeSchema = createApiEnvelopeSchema(IngestionJobSchema);
export const IngestionJobListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(IngestionJobSchema), page: CursorPageSchema }),
);
export const IngestionJobEventListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(IngestionJobEventSchema), nextCursor: z.number().int().nonnegative() }),
);
