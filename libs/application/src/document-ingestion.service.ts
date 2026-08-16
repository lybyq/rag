/**
 * M02 文档接入应用服务。
 * 它编排权限、对象存储直传、HEAD 校验与 PostgreSQL 事务，但不处理文件字节。
 *
 * @requirement DOC-003
 * @requirement DOC-004
 * @requirement DOC-005
 * @requirement DOC-006
 * @requirement DOC-008
 * @requirement DOC-011
 * @requirement DOC-017
 * @requirement DOC-018
 */
import type {
  CompleteUploadRequest,
  CompleteUploadResult,
  CreateUploadPartsRequest,
  CreateUploadSessionRequest,
  Document,
  IngestionJob,
  ListDocumentsQuery,
  ListIngestionJobsQuery,
  UploadPartInstruction,
  UploadSession,
} from '@rag/contracts';
import {
  calculatePartCount,
  chooseUploadStrategy,
  createIsolatedObjectKey,
  sanitizeOriginalFileName,
} from '@rag/ingestion-core';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from './application.error';
import type { AuthorizationService } from './authorization.service';
import type {
  CursorResult,
  DocumentDetail,
  DocumentIngestionRepository,
  DocumentVersionDetail,
  JobEventPage,
  ObjectStoragePort,
  StoredObjectHead,
  UploadFileRecord,
} from './ingestion.ports';
import type { AccessContext, SecurityAuditPort } from './ports';

/** 部署可调整的上传策略；单位明确使用字节和秒。 */
export interface UploadPolicyConfig {
  readonly bucket: string;
  readonly sessionTtlSeconds: number;
  readonly presignedUrlTtlSeconds: number;
  readonly maxFilesPerSession: number;
  readonly maxFileBytes: number;
  readonly multipartThresholdBytes: number;
  readonly partSizeBytes: number;
  readonly externalCallTimeoutMs: number;
}

/** HTTP 层调用的完整文档接入用例。 */
export class DocumentIngestionService {
  public constructor(
    private readonly repository: DocumentIngestionRepository,
    private readonly storage: ObjectStoragePort,
    private readonly authorization: AuthorizationService,
    private readonly audit: SecurityAuditPort,
    private readonly config: UploadPolicyConfig,
  ) {}

  /** 创建隔离上传会话；失败时补偿已经初始化的 Multipart。 */
  public async createUploadSession(
    context: AccessContext,
    request: CreateUploadSessionRequest,
  ): Promise<UploadSession> {
    await this.authorization.requirePermission(context, request.spaceId, 'WRITE');
    this.assertUploadLimits(request);

    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1_000);
    const initiated: { bucket: string; objectKey: string; uploadId: string }[] = [];
    try {
      await this.storage.ensureBucket(this.callOptions());
      const files = [];
      const singleUrls = new Map<string, string>();
      for (const descriptor of request.files) {
        const fileId = randomUUID();
        const objectKey = createIsolatedObjectKey(request.spaceId, sessionId, fileId);
        const strategy = chooseUploadStrategy(
          descriptor.sizeBytes,
          this.config.multipartThresholdBytes,
        );
        const partCount =
          strategy === 'MULTIPART'
            ? calculatePartCount(descriptor.sizeBytes, this.config.partSizeBytes)
            : 1;
        const multipartUploadId =
          strategy === 'MULTIPART'
            ? await this.storage.initiateMultipart(
                this.config.bucket,
                objectKey,
                descriptor.contentType,
                this.callOptions(),
              )
            : undefined;
        if (multipartUploadId) {
          initiated.push({ bucket: this.config.bucket, objectKey, uploadId: multipartUploadId });
        } else {
          singleUrls.set(
            fileId,
            await this.storage.presignPut(
              this.config.bucket,
              objectKey,
              this.config.presignedUrlTtlSeconds,
              this.callOptions(),
            ),
          );
        }
        files.push({
          ...descriptor,
          id: fileId,
          originalFileName: sanitizeOriginalFileName(descriptor.originalFileName),
          strategy,
          bucket: this.config.bucket,
          objectKey,
          ...(multipartUploadId ? { multipartUploadId } : {}),
          partSizeBytes: this.config.partSizeBytes,
          partCount,
        });
      }

      const session = await this.repository.createUploadSession(context, {
        id: sessionId,
        spaceId: request.spaceId,
        expiresAt,
        files,
      });
      await this.audit.append(context, {
        action: 'UPLOAD_SESSION_CREATE',
        resourceType: 'UPLOAD_SESSION',
        resourceId: session.id,
        result: 'SUCCESS',
        metadata: { fileCount: files.length },
      });
      return {
        ...session,
        files: session.files.map((file) => ({
          ...file,
          uploadUrl: singleUrls.get(file.fileId) ?? null,
        })),
      };
    } catch (error) {
      await Promise.allSettled(
        initiated.map((item) =>
          this.storage.abortMultipart(
            item.bucket,
            item.objectKey,
            item.uploadId,
            this.callOptions(),
          ),
        ),
      );
      throw error;
    }
  }

  /** 重新读取会话时签发新的单 PUT URL；旧 URL 不持久化。 */
  public async getUploadSession(
    context: AccessContext,
    uploadSessionId: string,
  ): Promise<UploadSession> {
    const session = await this.repository.getUploadSession(context, uploadSessionId);
    await this.authorization.requirePermission(context, session.spaceId, 'WRITE');
    if (session.status !== 'ACTIVE') return session;
    const files = await Promise.all(
      session.files.map(async (file) => {
        if (file.completed || file.strategy === 'MULTIPART') return file;
        const record = await this.repository.getUploadFile(context, file.fileId);
        return {
          ...file,
          uploadUrl: await this.storage.presignPut(
            record.bucket,
            record.objectKey,
            this.config.presignedUrlTtlSeconds,
            this.callOptions(),
          ),
        };
      }),
    );
    return { ...session, files };
  }

  /** 按需签发 Multipart 分片 URL，允许前端只重试失败分片。 */
  public async createUploadParts(
    context: AccessContext,
    uploadSessionId: string,
    request: CreateUploadPartsRequest,
  ): Promise<readonly UploadPartInstruction[]> {
    const file = await this.repository.getUploadFile(context, request.fileId);
    if (file.uploadSessionId !== uploadSessionId) {
      throw new ApplicationError('NOT_FOUND', 404, '上传文件不存在');
    }
    await this.authorization.requirePermission(context, file.spaceId, 'WRITE');
    this.assertUploadFileActive(file);
    if (file.strategy !== 'MULTIPART' || !file.multipartUploadId) {
      throw new ApplicationError('INVALID_STATE', 409, '该文件不是 Multipart 上传');
    }
    const uniqueParts = [...new Set(request.partNumbers)].sort((left, right) => left - right);
    if (uniqueParts.some((partNumber) => partNumber > file.partCount)) {
      throw new ApplicationError('OBJECT_MISMATCH', 409, '分片编号超出文件计划');
    }
    const expiresAt = new Date(
      Date.now() + this.config.presignedUrlTtlSeconds * 1_000,
    ).toISOString();
    return Promise.all(
      uniqueParts.map(async (partNumber) => ({
        partNumber,
        uploadUrl: await this.storage.presignPart(
          file.bucket,
          file.objectKey,
          file.multipartUploadId!,
          partNumber,
          this.config.presignedUrlTtlSeconds,
          this.callOptions(),
        ),
        expiresAt,
      })),
    );
  }

  /** 合并（如需要）并 HEAD 校验后，原子创建文档、版本、文件、任务和 Outbox。 */
  public async completeUpload(
    context: AccessContext,
    uploadSessionId: string,
    request: CompleteUploadRequest,
  ): Promise<CompleteUploadResult> {
    const completed = await this.repository.getCompletedUploadResult(context, request.fileId);
    if (completed) return completed;

    const file = await this.repository.getUploadFile(context, request.fileId);
    if (file.uploadSessionId !== uploadSessionId) {
      throw new ApplicationError('NOT_FOUND', 404, '上传文件不存在');
    }
    await this.authorization.requirePermission(context, file.spaceId, 'WRITE');
    this.assertUploadFileActive(file);

    let object;
    if (file.strategy === 'MULTIPART') {
      if (!file.multipartUploadId || request.parts.length !== file.partCount) {
        throw new ApplicationError('OBJECT_MISMATCH', 409, 'Multipart 分片数量不完整');
      }
      const distinctParts = new Set(request.parts.map((part) => part.partNumber));
      if (
        distinctParts.size !== file.partCount ||
        request.parts.some((part) => part.partNumber > file.partCount)
      ) {
        throw new ApplicationError('OBJECT_MISMATCH', 409, 'Multipart 分片编号不完整');
      }
      // MinIO 合并成功而 PG 事务失败时，对象已经存在；重试先 HEAD，避免重复合并失效 uploadId。
      object = await this.tryHead(file);
      if (!object) {
        try {
          await this.storage.completeMultipart(
            file.bucket,
            file.objectKey,
            file.multipartUploadId,
            request.parts,
            this.callOptions(),
          );
        } catch (completionError) {
          // 完成请求的响应可能丢失；再次 HEAD 成功即可证明对象已经原子合并。
          object = await this.tryHead(file);
          if (!object) throw completionError;
        }
        object ??= await this.storage.headObject(file.bucket, file.objectKey, this.callOptions());
      }
    } else if (request.parts.length > 0) {
      throw new ApplicationError('OBJECT_MISMATCH', 409, '单文件直传不能提交 Multipart 分片');
    }

    object ??= await this.storage.headObject(file.bucket, file.objectKey, this.callOptions());
    this.assertStoredObject(file, object, request.sha256);
    const result = await this.repository.completeUpload(context, {
      uploadFile: file,
      object,
      ...(request.sha256 ? { sha256: request.sha256 } : {}),
    });
    await this.audit.append(context, {
      action: 'UPLOAD_COMPLETE',
      resourceType: 'DOCUMENT',
      resourceId: result.document.id,
      result: 'SUCCESS',
      metadata: { sizeBytes: object.sizeBytes, contentRevision: 1 },
    });
    return result;
  }

  /** 先封闭会话写入口，再尽力清理未完成对象。 */
  public async cancelUploadSession(context: AccessContext, uploadSessionId: string): Promise<void> {
    const session = await this.repository.getUploadSession(context, uploadSessionId);
    await this.authorization.requirePermission(context, session.spaceId, 'WRITE');
    const files = await this.repository.listUploadFiles(context, uploadSessionId);
    await this.repository.cancelUploadSession(context, uploadSessionId);
    await Promise.allSettled(
      files
        .filter((file) => file.fileStatus === 'PENDING')
        .map((file) =>
          file.multipartUploadId
            ? this.storage.abortMultipart(
                file.bucket,
                file.objectKey,
                file.multipartUploadId,
                this.callOptions(),
              )
            : this.storage.removeObject(file.bucket, file.objectKey, this.callOptions()),
        ),
    );
    await this.audit.append(context, {
      action: 'UPLOAD_SESSION_CANCEL',
      resourceType: 'UPLOAD_SESSION',
      resourceId: uploadSessionId,
      result: 'SUCCESS',
    });
  }

  /** 文档列表始终先把请求空间收窄到当前授权范围。 */
  public async listDocuments(
    context: AccessContext,
    query: ListDocumentsQuery,
  ): Promise<CursorResult<Document>> {
    if (query.spaceId) await this.authorization.requirePermission(context, query.spaceId, 'READ');
    return this.repository.listDocuments(context, query);
  }

  public async getDocument(context: AccessContext, documentId: string): Promise<DocumentDetail> {
    await this.authorization.requireResourcePermission(context, 'DOCUMENT', documentId, 'READ');
    const detail = await this.repository.getDocument(context, documentId);
    if (!detail) throw new ApplicationError('NOT_FOUND', 404, '文档不存在');
    return detail;
  }

  public async getDocumentVersion(
    context: AccessContext,
    documentVersionId: string,
  ): Promise<DocumentVersionDetail> {
    const detail = await this.repository.getDocumentVersion(context, documentVersionId);
    if (!detail) throw new ApplicationError('NOT_FOUND', 404, '文档版本不存在');
    await this.authorization.requireResourcePermission(
      context,
      'DOCUMENT',
      detail.version.documentId,
      'READ',
    );
    return detail;
  }

  /** 新修订使用新稳定 Job ID，旧解析和任务事实保持不变。 */
  public async reprocessDocumentVersion(
    context: AccessContext,
    documentVersionId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<IngestionJob> {
    const detail = await this.getDocumentVersion(context, documentVersionId);
    await this.authorization.requireResourcePermission(
      context,
      'DOCUMENT',
      detail.version.documentId,
      'WRITE',
    );
    const job = await this.repository.reprocessDocumentVersion(
      context,
      documentVersionId,
      expectedVersion,
      reason,
    );
    await this.audit.append(context, {
      action: 'DOCUMENT_REPROCESS',
      resourceType: 'DOCUMENT',
      resourceId: detail.version.documentId,
      result: 'SUCCESS',
      reason,
      metadata: { contentRevision: job.contentRevision },
    });
    return job;
  }

  public async listJobs(
    context: AccessContext,
    query: ListIngestionJobsQuery,
  ): Promise<CursorResult<IngestionJob>> {
    if (query.spaceId) await this.authorization.requirePermission(context, query.spaceId, 'READ');
    return this.repository.listJobs(context, query);
  }

  public async getJob(context: AccessContext, jobId: string): Promise<IngestionJob> {
    const job = await this.repository.getJob(context, jobId);
    if (!job) throw new ApplicationError('NOT_FOUND', 404, '任务不存在');
    await this.authorization.requireResourcePermission(context, 'DOCUMENT', job.documentId, 'READ');
    return job;
  }

  public async cancelJob(
    context: AccessContext,
    jobId: string,
    reason: string,
  ): Promise<IngestionJob> {
    const job = await this.getJob(context, jobId);
    await this.authorization.requireResourcePermission(
      context,
      'DOCUMENT',
      job.documentId,
      'WRITE',
    );
    const cancelled = await this.repository.cancelJob(context, jobId, reason);
    await this.audit.append(context, {
      action: 'INGESTION_JOB_CANCEL',
      resourceType: 'DOCUMENT',
      resourceId: job.documentId,
      result: 'SUCCESS',
      reason,
      metadata: { jobId },
    });
    return cancelled;
  }

  public async listJobEvents(
    context: AccessContext,
    jobId: string,
    afterEventId: number,
    limit: number,
  ): Promise<JobEventPage> {
    await this.getJob(context, jobId);
    return this.repository.listJobEvents(context, jobId, afterEventId, limit);
  }

  private assertUploadLimits(request: CreateUploadSessionRequest): void {
    if (request.files.length > this.config.maxFilesPerSession) {
      throw new ApplicationError('UPLOAD_LIMIT_EXCEEDED', 413, '单次上传文件数量超过配置上限');
    }
    if (request.files.some((file) => file.sizeBytes > this.config.maxFileBytes)) {
      throw new ApplicationError('UPLOAD_LIMIT_EXCEEDED', 413, '文件大小超过配置上限');
    }
    const clientIds = new Set(request.files.map((file) => file.clientFileId));
    if (clientIds.size !== request.files.length) {
      throw new ApplicationError('DUPLICATE_RESOURCE', 409, 'clientFileId 不能重复');
    }
  }

  private assertUploadFileActive(file: UploadFileRecord): void {
    if (file.sessionStatus !== 'ACTIVE' || file.fileStatus !== 'PENDING') {
      throw new ApplicationError('INVALID_STATE', 409, '上传会话或文件不再可写');
    }
    if (file.expiresAt.getTime() <= Date.now()) {
      throw new ApplicationError('UPLOAD_EXPIRED', 410, '上传会话已过期');
    }
  }

  private assertStoredObject(
    file: UploadFileRecord,
    object: { sizeBytes: number; contentType?: string; sha256?: string },
    submittedSha256?: string,
  ): void {
    if (object.sizeBytes !== file.sizeBytes) {
      throw new ApplicationError('OBJECT_MISMATCH', 409, '对象大小与上传计划不一致');
    }
    if (object.contentType && object.contentType !== file.contentType) {
      throw new ApplicationError('OBJECT_MISMATCH', 409, '对象 MIME 与上传计划不一致');
    }
    const expectedHash = file.sha256 ?? submittedSha256;
    if (expectedHash && object.sha256 && expectedHash !== object.sha256) {
      throw new ApplicationError('OBJECT_MISMATCH', 409, '对象 SHA-256 与上传计划不一致');
    }
  }

  private callOptions(): { signal: AbortSignal } {
    return { signal: AbortSignal.timeout(this.config.externalCallTimeoutMs) };
  }

  /** HEAD 不存在或暂时失败时返回 undefined，由 Multipart 完成流程继续判定。 */
  private async tryHead(file: UploadFileRecord): Promise<StoredObjectHead | undefined> {
    try {
      return await this.storage.headObject(file.bucket, file.objectKey, this.callOptions());
    } catch {
      return undefined;
    }
  }
}
