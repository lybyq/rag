/** 文档接入与任务 应用编排测试：大文件直传、隔离路径、HEAD 拒绝和 Outbox 失败释放。 */
import type {
  AccessContext,
  AuthorizationService,
  CreateUploadFileCommand,
  DocumentIngestionRepository,
  ObjectStoragePort,
  SecurityAuditPort,
} from '.';
import { DocumentIngestionService } from './document-ingestion.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { createTestUserContext } from '@rag/testing';

const context: AccessContext = {
  user: createTestUserContext('document-ingestion-user', ['KNOWLEDGE_EDITOR']),
  requestId: 'document-ingestion-unit-request',
};

function serviceFixture(): {
  service: DocumentIngestionService;
  repository: jest.Mocked<DocumentIngestionRepository>;
  storage: jest.Mocked<ObjectStoragePort>;
} {
  const repository = {
    createUploadSession: jest.fn(async (_context, command) => ({
      id: command.id,
      spaceId: command.spaceId,
      status: 'ACTIVE' as const,
      expiresAt: command.expiresAt.toISOString(),
      createdAt: new Date().toISOString(),
      files: command.files.map((file: CreateUploadFileCommand) => ({
        fileId: file.id,
        clientFileId: file.clientFileId,
        originalFileName: file.originalFileName,
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
        strategy: file.strategy,
        partSizeBytes: file.partSizeBytes,
        partCount: file.partCount,
        uploadUrl: null,
        expiresAt: command.expiresAt.toISOString(),
        completed: false,
      })),
    })),
    findDocumentBatchByIdempotency: jest.fn().mockResolvedValue(undefined),
    getUploadSession: jest.fn(),
    listUploadFiles: jest.fn(),
    getCompletedUploadResult: jest.fn().mockResolvedValue(undefined),
    getUploadFile: jest.fn(),
    completeUpload: jest.fn(),
  } as unknown as jest.Mocked<DocumentIngestionRepository>;
  const storage = {
    ensureBucket: jest.fn().mockResolvedValue(undefined),
    ensureNamedBucket: jest.fn().mockResolvedValue(undefined),
    initiateMultipart: jest.fn().mockResolvedValue('multipart-id'),
    presignPut: jest.fn().mockResolvedValue('http://minio/single'),
    presignGet: jest.fn().mockResolvedValue('http://minio/download'),
    presignPart: jest.fn().mockResolvedValue('http://minio/part'),
    completeMultipart: jest.fn().mockResolvedValue(undefined),
    abortMultipart: jest.fn().mockResolvedValue(undefined),
    removeObject: jest.fn().mockResolvedValue(undefined),
    headObject: jest.fn(),
    readObject: jest.fn().mockResolvedValue(
      (async function* (): AsyncGenerator<Uint8Array> {
        yield new Uint8Array();
      })(),
    ),
    putObject: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<ObjectStoragePort>;
  const authorization = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuthorizationService;
  const audit = { append: jest.fn().mockResolvedValue(undefined) } as unknown as SecurityAuditPort;
  return {
    repository,
    storage,
    service: new DocumentIngestionService(repository, storage, authorization, audit, {
      bucket: 'rag-quarantine',
      sessionTtlSeconds: 3_600,
      presignedUrlTtlSeconds: 900,
      maxFilesPerSession: 100,
      maxFileBytes: 2 * 1024 * 1024 * 1024,
      multipartThresholdBytes: 16 * 1024 * 1024,
      partSizeBytes: 8 * 1024 * 1024,
      externalCallTimeoutMs: 3_000,
    }),
  };
}

describe('DocumentIngestionService', () => {
  it('OPT-013 同一个批次幂等键和请求只创建一次，不同请求返回 409', async () => {
    const { service, repository } = serviceFixture();
    const spaceId = '0198a8f4-12f8-7000-8000-111111111111';
    const request = {
      files: [
        {
          clientFileId: 'external-file-1',
          externalSourceId: 'finance-system',
          externalDocumentId: 'policy-2026',
          originalFileName: '差旅制度.pdf',
          sizeBytes: 1024,
          contentType: 'application/pdf',
          sha256: 'a'.repeat(64),
        },
      ],
    };

    const created = await service.createDocumentBatch(
      context,
      spaceId,
      'business-request-0001',
      request,
    );
    const command = repository.createUploadSession.mock.calls[0]?.[1];
    expect(created.replayed).toBe(false);
    expect(command?.externalBatch).toEqual(
      expect.objectContaining({ idempotencyKey: 'business-request-0001' }),
    );
    expect(command?.files[0]).toEqual(
      expect.objectContaining({
        externalSourceId: 'finance-system',
        externalDocumentId: 'policy-2026',
      }),
    );

    repository.findDocumentBatchByIdempotency.mockResolvedValue({
      uploadSessionId: created.batchId,
      requestSha256: command!.externalBatch!.requestSha256,
    });
    repository.getUploadSession.mockResolvedValue({
      ...created.uploadSession,
      status: 'COMPLETED',
    });
    await expect(
      service.createDocumentBatch(context, spaceId, 'business-request-0001', request),
    ).resolves.toEqual(expect.objectContaining({ batchId: created.batchId, replayed: true }));
    expect(repository.createUploadSession).toHaveBeenCalledTimes(1);

    await expect(
      service.createDocumentBatch(context, spaceId, 'business-request-0001', {
        files: [{ ...request.files[0]!, sizeBytes: 2048 }],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'DUPLICATE_RESOURCE', httpStatus: 409 }));
  });

  it('OPT-013 批次状态按文件返回真实上传与 Job 进度，未完成文件不伪造 Job', async () => {
    const { service, repository } = serviceFixture();
    const batchId = '0198a8f4-12f8-7000-8000-777777777777';
    const spaceId = '0198a8f4-12f8-7000-8000-111111111111';
    const completedFileId = '0198a8f4-12f8-7000-8000-888888888888';
    const pendingFileId = '0198a8f4-12f8-7000-8000-999999999999';
    const expiresAt = new Date(Date.now() + 60_000);
    const createdAt = new Date().toISOString();
    repository.getUploadSession.mockResolvedValue({
      id: batchId,
      spaceId,
      status: 'ACTIVE',
      expiresAt: expiresAt.toISOString(),
      createdAt,
      files: [
        {
          fileId: completedFileId,
          clientFileId: 'completed-file',
          originalFileName: '已完成.pdf',
          sizeBytes: 10,
          contentType: 'application/pdf',
          strategy: 'SINGLE',
          partSizeBytes: 8 * 1024 * 1024,
          partCount: 1,
          uploadUrl: null,
          expiresAt: expiresAt.toISOString(),
          completed: true,
        },
        {
          fileId: pendingFileId,
          clientFileId: 'pending-file',
          originalFileName: '上传中.pdf',
          sizeBytes: 20 * 1024 * 1024,
          contentType: 'application/pdf',
          strategy: 'MULTIPART',
          partSizeBytes: 8 * 1024 * 1024,
          partCount: 3,
          uploadUrl: null,
          expiresAt: expiresAt.toISOString(),
          completed: false,
        },
      ],
    });
    repository.listUploadFiles.mockResolvedValue([
      {
        id: completedFileId,
        uploadSessionId: batchId,
        spaceId,
        clientFileId: 'completed-file',
        externalSourceId: 'finance-system',
        externalDocumentId: 'completed-policy',
        originalFileName: '已完成.pdf',
        strategy: 'SINGLE',
        bucket: 'rag-quarantine',
        objectKey: 'isolated/completed',
        sizeBytes: 10,
        contentType: 'application/pdf',
        partSizeBytes: 8 * 1024 * 1024,
        partCount: 1,
        sessionStatus: 'ACTIVE',
        fileStatus: 'COMPLETED',
        expiresAt,
      },
      {
        id: pendingFileId,
        uploadSessionId: batchId,
        spaceId,
        clientFileId: 'pending-file',
        externalSourceId: 'finance-system',
        externalDocumentId: 'pending-policy',
        originalFileName: '上传中.pdf',
        strategy: 'MULTIPART',
        bucket: 'rag-quarantine',
        objectKey: 'isolated/pending',
        multipartUploadId: 'multipart-pending',
        sizeBytes: 20 * 1024 * 1024,
        contentType: 'application/pdf',
        partSizeBytes: 8 * 1024 * 1024,
        partCount: 3,
        sessionStatus: 'ACTIVE',
        fileStatus: 'PENDING',
        expiresAt,
      },
    ]);
    repository.getCompletedUploadResult.mockResolvedValue({
      document: { id: '0198a8f4-12f8-7000-8000-aaaaaaaaaaaa' },
      documentVersion: { id: '0198a8f4-12f8-7000-8000-bbbbbbbbbbbb' },
      job: {
        id: 'job-completed-file',
        status: 'RUNNING',
        currentStep: 'PARSE',
        overallPercent: 18,
        publicMessage: '正在解析文件',
      },
    } as never);

    const result = await service.getDocumentBatch(context, batchId);

    expect(result.files).toEqual([
      expect.objectContaining({
        fileId: completedFileId,
        documentId: '0198a8f4-12f8-7000-8000-aaaaaaaaaaaa',
        jobId: 'job-completed-file',
        overallPercent: 18,
      }),
      expect.objectContaining({
        fileId: pendingFileId,
        documentId: null,
        jobId: null,
        overallPercent: null,
      }),
    ]);
    expect(repository.getCompletedUploadResult).toHaveBeenCalledTimes(1);
  });

  it('200 MiB 只以元数据创建 Multipart，隔离路径不含原文件名', async () => {
    const { service, repository, storage } = serviceFixture();
    const session = await service.createUploadSession(context, {
      spaceId: '0198a8f4-12f8-7000-8000-111111111111',
      files: [
        {
          clientFileId: 'large-file',
          originalFileName: '../../董事会材料.pdf',
          sizeBytes: 200 * 1024 * 1024,
          contentType: 'application/pdf',
        },
      ],
    });

    expect(session.files[0]?.strategy).toBe('MULTIPART');
    expect(session.files[0]?.partCount).toBe(25);
    expect(storage.initiateMultipart).toHaveBeenCalledTimes(1);
    const command = repository.createUploadSession.mock.calls[0]?.[1];
    expect(command?.files[0]?.objectKey).not.toContain('董事会');
    expect(command?.files[0]?.originalFileName).toBe('董事会材料.pdf');
    expect(repository.createUploadSession.mock.calls[0]?.[0]).toBe(context);
  });

  it('HEAD 大小不一致时不创建数据库事实', async () => {
    const { service, repository, storage } = serviceFixture();
    repository.getUploadFile.mockResolvedValue({
      id: '0198a8f4-12f8-7000-8000-222222222222',
      uploadSessionId: '0198a8f4-12f8-7000-8000-333333333333',
      spaceId: '0198a8f4-12f8-7000-8000-111111111111',
      clientFileId: 'file-1',
      originalFileName: '制度.pdf',
      strategy: 'SINGLE',
      bucket: 'rag-quarantine',
      objectKey: 'isolated/object',
      sizeBytes: 100,
      contentType: 'application/pdf',
      partSizeBytes: 8 * 1024 * 1024,
      partCount: 1,
      sessionStatus: 'ACTIVE',
      fileStatus: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
    });
    storage.headObject.mockResolvedValue({ sizeBytes: 99, contentType: 'application/pdf' });

    await expect(
      service.completeUpload(context, '0198a8f4-12f8-7000-8000-333333333333', {
        fileId: '0198a8f4-12f8-7000-8000-222222222222',
        parts: [],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'OBJECT_MISMATCH' }));
    expect(repository.completeUpload).not.toHaveBeenCalled();
  });

  it('OPT-013 相同外部内容复用原事实后尽力删除本次重复隔离对象', async () => {
    const { service, repository, storage } = serviceFixture();
    const fileId = '0198a8f4-12f8-7000-8000-cccccccccccc';
    const uploadSessionId = '0198a8f4-12f8-7000-8000-dddddddddddd';
    repository.getUploadFile.mockResolvedValue({
      id: fileId,
      uploadSessionId,
      spaceId: '0198a8f4-12f8-7000-8000-111111111111',
      clientFileId: 'external-duplicate',
      externalSourceId: 'finance-system',
      externalDocumentId: 'policy-2026',
      originalFileName: '重复制度.pdf',
      strategy: 'SINGLE',
      bucket: 'rag-quarantine',
      objectKey: 'isolated/new-duplicate',
      sizeBytes: 100,
      contentType: 'application/pdf',
      sha256: 'a'.repeat(64),
      partSizeBytes: 8 * 1024 * 1024,
      partCount: 1,
      sessionStatus: 'ACTIVE',
      fileStatus: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
    });
    storage.headObject.mockResolvedValue({
      sizeBytes: 100,
      contentType: 'application/pdf',
      sha256: 'a'.repeat(64),
    });
    repository.completeUpload.mockResolvedValue({
      document: { id: '0198a8f4-12f8-7000-8000-eeeeeeeeeeee' },
      file: { objectKey: 'isolated/original' },
    } as never);

    await service.completeUpload(context, uploadSessionId, { fileId, parts: [] });

    expect(storage.removeObject).toHaveBeenCalledWith(
      'rag-quarantine',
      'isolated/new-duplicate',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('Multipart 已合并但 PG 未提交时，重试通过 HEAD 跳过第二次合并', async () => {
    const { service, repository, storage } = serviceFixture();
    const fileId = '0198a8f4-12f8-7000-8000-555555555555';
    const uploadSessionId = '0198a8f4-12f8-7000-8000-666666666666';
    repository.getUploadFile.mockResolvedValue({
      id: fileId,
      uploadSessionId,
      spaceId: '0198a8f4-12f8-7000-8000-111111111111',
      clientFileId: 'large',
      originalFileName: '大文件.pdf',
      strategy: 'MULTIPART',
      bucket: 'rag-quarantine',
      objectKey: 'isolated/large',
      sizeBytes: 10,
      contentType: 'application/pdf',
      multipartUploadId: 'already-completed-upload',
      partSizeBytes: 5,
      partCount: 2,
      sessionStatus: 'ACTIVE',
      fileStatus: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
    });
    storage.headObject.mockResolvedValue({ sizeBytes: 10, contentType: 'application/pdf' });
    repository.completeUpload.mockRejectedValue(new Error('simulated PG failure'));

    await expect(
      service.completeUpload(context, uploadSessionId, {
        fileId,
        parts: [
          { partNumber: 1, etag: 'part-1' },
          { partNumber: 2, etag: 'part-2' },
        ],
      }),
    ).rejects.toThrow('simulated PG failure');
    expect(storage.completeMultipart).not.toHaveBeenCalled();
    expect(repository.completeUpload).toHaveBeenCalledTimes(1);
  });
});

describe('OutboxPublisherService', () => {
  it('投递失败释放 lease，成功后才标记 published', async () => {
    const event = {
      id: '0198a8f4-12f8-7000-8000-444444444444',
      aggregateType: 'INGESTION_JOB',
      aggregateId: 'job-1',
      eventType: 'ingestion.requested',
      payload: {},
      occurredAt: new Date().toISOString(),
      publishedAt: null,
      attempts: 1,
    };
    const repository = {
      claimOutboxBatch: jest.fn().mockResolvedValue([event]),
      markOutboxPublished: jest.fn(),
      releaseOutboxEvent: jest.fn(),
    } as unknown as jest.Mocked<DocumentIngestionRepository>;
    const publisher = { publish: jest.fn().mockRejectedValue(new Error('redis down')) };
    const service = new OutboxPublisherService(repository, publisher, 'publisher-1');

    await expect(service.publishOnce()).resolves.toBe(0);
    expect(repository.markOutboxPublished).not.toHaveBeenCalled();
    expect(repository.releaseOutboxEvent).toHaveBeenCalledWith(event.id, 'redis down', 10);
  });
});
