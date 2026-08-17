/** MinIO Port 契约测试覆盖成功、错误、取消和 metadata 兼容路径。 */
import type { AppConfig } from '@rag/config';
import type { MinioStorageClient } from './minio-object-storage.adapter';
import { MinioObjectStorageAdapter } from './minio-object-storage.adapter';

const config = {
  minio: {
    endpoint: 'http://localhost:9000',
    accessKey: 'access',
    secretKey: 'secret-value',
    uploadBucket: 'rag-quarantine',
  },
} as AppConfig;

function clientStub(overrides: Partial<MinioStorageClient> = {}): MinioStorageClient {
  return {
    bucketExists: jest.fn().mockResolvedValue(true),
    makeBucket: jest.fn().mockResolvedValue(undefined),
    initiateNewMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    presignedPutObject: jest.fn().mockResolvedValue('http://minio/single'),
    presignedUrl: jest.fn().mockResolvedValue('http://minio/part'),
    completeMultipartUpload: jest.fn().mockResolvedValue({ etag: 'all', versionId: null }),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    removeObject: jest.fn().mockResolvedValue(undefined),
    statObject: jest.fn().mockResolvedValue({
      size: 12,
      etag: '"abc"',
      lastModified: new Date(),
      metaData: { 'content-type': 'application/pdf', 'x-amz-meta-sha256': 'A'.repeat(64) },
    }),
    getObject: jest.fn().mockResolvedValue(
      (async function* (): AsyncGenerator<Uint8Array> {
        yield Buffer.from('bytes');
      })(),
    ),
    putObject: jest.fn().mockResolvedValue({ etag: 'derived', versionId: null }),
    ...overrides,
  } as unknown as MinioStorageClient;
}

describe('MinioObjectStorageAdapter contract', () => {
  it('签发绑定 uploadId 和 partNumber 的 Multipart URL', async () => {
    const client = clientStub();
    const adapter = new MinioObjectStorageAdapter(config, client);
    await expect(
      adapter.presignPart('bucket', 'object', 'upload-1', 2, 300, {
        signal: new AbortController().signal,
      }),
    ).resolves.toBe('http://minio/part');
    expect(client.presignedUrl).toHaveBeenCalledWith('PUT', 'bucket', 'object', 300, {
      uploadId: 'upload-1',
      partNumber: '2',
    });
  });

  it('HEAD 统一 ETag 和 metadata 大小写', async () => {
    const adapter = new MinioObjectStorageAdapter(config, clientStub());
    await expect(
      adapter.headObject('bucket', 'object', { signal: new AbortController().signal }),
    ).resolves.toEqual({
      sizeBytes: 12,
      contentType: 'application/pdf',
      etag: 'abc',
      sha256: 'a'.repeat(64),
    });
  });

  it('[PAR-012] 派生快照写入可信 SHA metadata，并签发只读 URL', async () => {
    const client = clientStub();
    const adapter = new MinioObjectStorageAdapter(config, client);
    const signal = new AbortController().signal;
    await adapter.ensureNamedBucket('rag-derived', { signal });
    await adapter.putObject(
      'rag-derived',
      'derived/version/blocks.json',
      {
        bytes: Buffer.from('{}'),
        contentType: 'application/json',
        sha256: 'b'.repeat(64),
      },
      { signal },
    );
    await adapter.presignGet('rag-quarantine', 'object', 300, { signal });

    expect(client.putObject).toHaveBeenCalledWith(
      'rag-derived',
      'derived/version/blocks.json',
      expect.any(Buffer),
      2,
      expect.objectContaining({ 'x-amz-meta-sha256': 'b'.repeat(64) }),
    );
    expect(client.presignedUrl).toHaveBeenCalledWith('GET', 'rag-quarantine', 'object', 300);
  });

  it('透传对象存储错误并响应取消信号', async () => {
    const client = clientStub({ statObject: jest.fn().mockRejectedValue(new Error('NoSuchKey')) });
    const adapter = new MinioObjectStorageAdapter(config, client);
    await expect(
      adapter.headObject('bucket', 'missing', { signal: new AbortController().signal }),
    ).rejects.toThrow('NoSuchKey');

    const aborted = new AbortController();
    aborted.abort(new Error('deadline'));
    await expect(
      adapter.presignPut('bucket', 'object', 300, { signal: aborted.signal }),
    ).rejects.toThrow('deadline');
  });
});
