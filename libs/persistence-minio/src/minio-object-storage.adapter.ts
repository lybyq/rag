/**
 * MinIO/S3 对象存储 Adapter。
 * 浏览器使用预签名 URL 直传，Platform API 只创建会话、合并分片和执行 HEAD。
 *
 * @requirement DOC-003
 * @requirement DOC-005
 * @requirement DOC-006
 */
import type {
  CompletedStoragePart,
  ExternalCallOptions,
  ObjectStoragePort,
  StoredObjectHead,
} from '@rag/application';
import type { AppConfig } from '@rag/config';
import { Client } from 'minio';

/** 测试只需实现这组 MinIO 方法，不需要启动真实 SDK 客户端。 */
export type MinioStorageClient = Pick<
  Client,
  | 'bucketExists'
  | 'makeBucket'
  | 'initiateNewMultipartUpload'
  | 'presignedPutObject'
  | 'presignedUrl'
  | 'completeMultipartUpload'
  | 'abortMultipartUpload'
  | 'removeObject'
  | 'statObject'
>;

/** 将配置 URL 转成 MinIO SDK 连接参数。 */
function createClient(config: AppConfig): Client {
  const endpoint = new URL(config.minio.endpoint);
  return new Client({
    endPoint: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
    useSSL: endpoint.protocol === 'https:',
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
    pathStyle: true,
  });
}

/** 生产 Adapter，也允许契约测试注入最小 MinIO 替身。 */
export class MinioObjectStorageAdapter implements ObjectStoragePort {
  private readonly bucket: string;
  private readonly client: MinioStorageClient;

  public constructor(config: AppConfig, client?: MinioStorageClient) {
    this.bucket = config.minio.uploadBucket;
    this.client = client ?? createClient(config);
  }

  /** Bucket 不存在时创建；并发创建的 BucketAlreadyOwnedByYou 视为成功。 */
  public async ensureBucket(options: ExternalCallOptions): Promise<void> {
    if (await withAbort(this.client.bucketExists(this.bucket), options.signal)) return;
    try {
      await withAbort(this.client.makeBucket(this.bucket), options.signal);
    } catch (error) {
      if (!isAlreadyOwnedBucketError(error)) throw error;
    }
  }

  public initiateMultipart(
    bucket: string,
    objectKey: string,
    contentType: string,
    options: ExternalCallOptions,
  ): Promise<string> {
    return withAbort(
      this.client.initiateNewMultipartUpload(bucket, objectKey, {
        'content-type': contentType,
      }),
      options.signal,
    );
  }

  public presignPut(
    bucket: string,
    objectKey: string,
    expiresSeconds: number,
    options: ExternalCallOptions,
  ): Promise<string> {
    return withAbort(
      this.client.presignedPutObject(bucket, objectKey, expiresSeconds),
      options.signal,
    );
  }

  /** partNumber/uploadId 进入签名 Query，客户端无法换分片或换对象。 */
  public presignPart(
    bucket: string,
    objectKey: string,
    uploadId: string,
    partNumber: number,
    expiresSeconds: number,
    options: ExternalCallOptions,
  ): Promise<string> {
    return withAbort(
      this.client.presignedUrl('PUT', bucket, objectKey, expiresSeconds, {
        uploadId,
        partNumber: String(partNumber),
      }),
      options.signal,
    );
  }

  public async completeMultipart(
    bucket: string,
    objectKey: string,
    uploadId: string,
    parts: readonly CompletedStoragePart[],
    options: ExternalCallOptions,
  ): Promise<void> {
    await withAbort(
      this.client.completeMultipartUpload(
        bucket,
        objectKey,
        uploadId,
        [...parts]
          .sort((left, right) => left.partNumber - right.partNumber)
          .map((part) => ({ part: part.partNumber, etag: stripEtagQuotes(part.etag) })),
      ),
      options.signal,
    );
  }

  public abortMultipart(
    bucket: string,
    objectKey: string,
    uploadId: string,
    options: ExternalCallOptions,
  ): Promise<void> {
    return withAbort(this.client.abortMultipartUpload(bucket, objectKey, uploadId), options.signal);
  }

  public removeObject(
    bucket: string,
    objectKey: string,
    options: ExternalCallOptions,
  ): Promise<void> {
    return withAbort(this.client.removeObject(bucket, objectKey), options.signal);
  }

  /** 从标准 Content-Type 和自定义 SHA-256 metadata 提取可校验事实。 */
  public async headObject(
    bucket: string,
    objectKey: string,
    options: ExternalCallOptions,
  ): Promise<StoredObjectHead> {
    const stat = await withAbort(this.client.statObject(bucket, objectKey), options.signal);
    const contentType = readMetadata(stat.metaData, 'content-type');
    const sha256 =
      readMetadata(stat.metaData, 'x-amz-meta-sha256') ?? readMetadata(stat.metaData, 'sha256');
    return {
      sizeBytes: stat.size,
      ...(contentType ? { contentType } : {}),
      ...(stat.etag ? { etag: stripEtagQuotes(stat.etag) } : {}),
      ...(sha256 ? { sha256: sha256.toLowerCase() } : {}),
    };
  }
}

/** AbortSignal 只控制调用等待边界；SDK 连接仍由其自身 socket timeout 回收。 */
async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** MinIO metadata 的大小写可能因网关实现不同而变化。 */
function readMetadata(metadata: Record<string, unknown>, wantedKey: string): string | undefined {
  const entry = Object.entries(metadata).find(([key]) => key.toLowerCase() === wantedKey);
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

/** ETag XML 不能带 HTTP Header 中的双引号。 */
function stripEtagQuotes(etag: string): string {
  return etag.replace(/^"|"$/g, '');
}

/** 兼容 MinIO 与 AWS S3 对“Bucket 已属于当前账号”的错误命名。 */
function isAlreadyOwnedBucketError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(String(error.code));
}
