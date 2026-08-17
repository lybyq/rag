/**
 * M02 应用层端口。
 * 端口只表达上传、事实事务、Outbox 和事件投递所需能力，不暴露 SDK 细节。
 */
import type {
  CompleteUploadResult,
  Document,
  DocumentFile,
  DocumentVersion,
  IngestionJob,
  IngestionJobEvent,
  ListDocumentsQuery,
  ListIngestionJobsQuery,
  OutboxEvent,
  UploadFileDescriptor,
  UploadSession,
  UploadStrategy,
} from '@rag/contracts';
import type { AccessContext } from './ports';

/** 每次对象存储调用都携带取消信号，防止外部依赖无限占用请求。 */
export interface ExternalCallOptions {
  readonly signal: AbortSignal;
}

/** HEAD 返回完成上传所需的可信对象事实。 */
export interface StoredObjectHead {
  readonly sizeBytes: number;
  readonly contentType?: string;
  readonly etag?: string;
  readonly sha256?: string;
}

/** 写入派生对象时使用的内容事实；SHA 会进入对象 metadata 供幂等重试验证。 */
export interface StoredObjectBody {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
}

/** Multipart 合并所需的分片事实。 */
export interface CompletedStoragePart {
  readonly partNumber: number;
  readonly etag: string;
}

/** 可替换的 MinIO/S3 对象存储端口。 */
export interface ObjectStoragePort {
  ensureBucket(options: ExternalCallOptions): Promise<void>;
  ensureNamedBucket(bucket: string, options: ExternalCallOptions): Promise<void>;
  initiateMultipart(
    bucket: string,
    objectKey: string,
    contentType: string,
    options: ExternalCallOptions,
  ): Promise<string>;
  presignPut(
    bucket: string,
    objectKey: string,
    expiresSeconds: number,
    options: ExternalCallOptions,
  ): Promise<string>;
  presignGet(
    bucket: string,
    objectKey: string,
    expiresSeconds: number,
    options: ExternalCallOptions,
  ): Promise<string>;
  presignPart(
    bucket: string,
    objectKey: string,
    uploadId: string,
    partNumber: number,
    expiresSeconds: number,
    options: ExternalCallOptions,
  ): Promise<string>;
  completeMultipart(
    bucket: string,
    objectKey: string,
    uploadId: string,
    parts: readonly CompletedStoragePart[],
    options: ExternalCallOptions,
  ): Promise<void>;
  abortMultipart(
    bucket: string,
    objectKey: string,
    uploadId: string,
    options: ExternalCallOptions,
  ): Promise<void>;
  removeObject(bucket: string, objectKey: string, options: ExternalCallOptions): Promise<void>;
  headObject(
    bucket: string,
    objectKey: string,
    options: ExternalCallOptions,
  ): Promise<StoredObjectHead>;
  readObject(
    bucket: string,
    objectKey: string,
    options: ExternalCallOptions,
  ): Promise<AsyncIterable<Uint8Array>>;
  putObject(
    bucket: string,
    objectKey: string,
    body: StoredObjectBody,
    options: ExternalCallOptions,
  ): Promise<void>;
}

/** 创建会话时写入数据库的单文件命令。 */
export interface CreateUploadFileCommand extends UploadFileDescriptor {
  readonly id: string;
  readonly originalFileName: string;
  readonly strategy: UploadStrategy;
  readonly bucket: string;
  readonly objectKey: string;
  readonly multipartUploadId?: string;
  readonly partSizeBytes: number;
  readonly partCount: number;
}

/** 创建上传会话的原子数据库命令。 */
export interface CreateUploadSessionCommand {
  readonly id: string;
  readonly spaceId: string;
  readonly expiresAt: Date;
  readonly files: readonly CreateUploadFileCommand[];
}

/** Repository 内部使用的上传文件定位事实，不会直接返回浏览器。 */
export interface UploadFileRecord extends CreateUploadFileCommand {
  readonly uploadSessionId: string;
  readonly spaceId: string;
  readonly sessionStatus: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
  readonly fileStatus: 'PENDING' | 'COMPLETED' | 'CANCELLED';
  readonly expiresAt: Date;
}

/** 上传完成事务命令；对象事实已经由 Adapter HEAD 验证。 */
export interface CompleteUploadCommand {
  readonly uploadFile: UploadFileRecord;
  readonly object: StoredObjectHead;
  readonly sha256?: string;
}

/** 文档及其所有版本的详情。 */
export interface DocumentDetail {
  readonly document: Document;
  readonly versions: readonly DocumentVersion[];
}

/** 文档版本及原始文件事实。 */
export interface DocumentVersionDetail {
  readonly version: DocumentVersion;
  readonly files: readonly DocumentFile[];
}

/** 稳定游标列表。 */
export interface CursorResult<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** 事件轮询结果同时提供下一个数值游标和内容 ETag。 */
export interface JobEventPage {
  readonly items: readonly IngestionJobEvent[];
  readonly nextCursor: number;
  readonly etag: string;
}

/** PostgreSQL 文档接入事实源端口。 */
export interface DocumentIngestionRepository {
  createUploadSession(
    context: AccessContext,
    command: CreateUploadSessionCommand,
  ): Promise<UploadSession>;
  getUploadSession(context: AccessContext, uploadSessionId: string): Promise<UploadSession>;
  getUploadFile(context: AccessContext, uploadFileId: string): Promise<UploadFileRecord>;
  getCompletedUploadResult(
    context: AccessContext,
    uploadFileId: string,
  ): Promise<CompleteUploadResult | undefined>;
  completeUpload(
    context: AccessContext,
    command: CompleteUploadCommand,
  ): Promise<CompleteUploadResult>;
  cancelUploadSession(context: AccessContext, uploadSessionId: string): Promise<void>;
  listUploadFiles(
    context: AccessContext,
    uploadSessionId: string,
  ): Promise<readonly UploadFileRecord[]>;
  listDocuments(context: AccessContext, query: ListDocumentsQuery): Promise<CursorResult<Document>>;
  getDocument(context: AccessContext, documentId: string): Promise<DocumentDetail | undefined>;
  getDocumentVersion(
    context: AccessContext,
    documentVersionId: string,
  ): Promise<DocumentVersionDetail | undefined>;
  reprocessDocumentVersion(
    context: AccessContext,
    documentVersionId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<IngestionJob>;
  listJobs(
    context: AccessContext,
    query: ListIngestionJobsQuery,
  ): Promise<CursorResult<IngestionJob>>;
  getJob(context: AccessContext, jobId: string): Promise<IngestionJob | undefined>;
  cancelJob(context: AccessContext, jobId: string, reason: string): Promise<IngestionJob>;
  listJobEvents(
    context: AccessContext,
    jobId: string,
    afterEventId: number,
    limit: number,
  ): Promise<JobEventPage>;
  claimOutboxBatch(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly OutboxEvent[]>;
  markOutboxPublished(eventId: string): Promise<void>;
  releaseOutboxEvent(eventId: string, reason: string, retryDelaySeconds: number): Promise<void>;
  recordConsumerReceipt(consumerName: string, eventId: string): Promise<boolean>;
  consumeQueuedIngestion(consumerName: string, eventId: string, jobId: string): Promise<boolean>;
  acquireJobLease(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<IngestionJob | undefined>;
  heartbeatJob(
    jobId: string,
    workerId: string,
    progress: {
      readonly stepName: IngestionJob['currentStep'];
      readonly processedUnits: number;
      readonly totalUnits: number | null;
      readonly publicMessage: string;
    },
    leaseSeconds: number,
  ): Promise<IngestionJob | undefined>;
  renewJobLease(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  recoverExpiredLeases(now: Date, maxAttempts: number): Promise<number>;
}

/** Outbox 的实际传输端口；外网可用 Redis，内网可换成企业消息平台。 */
export interface IngestionEventPublisherPort {
  publish(event: OutboxEvent, options: ExternalCallOptions): Promise<void>;
}

/** M02 依赖注入 Token。 */
export const DOCUMENT_INGESTION_REPOSITORY = Symbol('DOCUMENT_INGESTION_REPOSITORY');
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
export const INGESTION_EVENT_PUBLISHER = Symbol('INGESTION_EVENT_PUBLISHER');
