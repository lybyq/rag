/**
 * 通过 MinIO/S3 的 ListBuckets 协议检查对象存储凭证和连接。
 * 健康结果不会返回 Endpoint、Access Key 或服务端原始错误。
 *
 * @requirement BASE-009
 */
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import type { DependencyHealth, HealthProbe } from '@rag/contracts';
import { Client } from 'minio';

/** MinIO 就绪探针。 */
@Injectable()
export class MinioHealthProbe implements HealthProbe {
  public readonly name = 'minio';
  private readonly client: Client;

  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const endpoint = new URL(config.minio.endpoint);
    this.client = new Client({
      endPoint: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
      useSSL: endpoint.protocol === 'https:',
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
      pathStyle: true,
    });
  }

  /** 调用只读 Bucket 列表接口，验证网络、协议和凭证。 */
  public async check(): Promise<DependencyHealth> {
    const startedAt = performance.now();
    try {
      await this.client.listBuckets();
      return { name: this.name, status: 'up', latencyMs: performance.now() - startedAt };
    } catch {
      return {
        name: this.name,
        status: 'down',
        latencyMs: performance.now() - startedAt,
        message: 'MinIO 协议检查失败',
      };
    }
  }
}
