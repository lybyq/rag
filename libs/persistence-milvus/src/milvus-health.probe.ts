/**
 * 调用 Milvus CheckHealth，验证 gRPC 服务而非仅测试端口。
 * SDK 配置保留超时与认证入口，后续 Collection Adapter 与此处共享 Profile。
 *
 * @requirement BASE-009
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import type { DependencyHealth, HealthProbe } from '@rag/contracts';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';

/** Milvus 就绪探针。 */
@Injectable()
export class MilvusHealthProbe implements HealthProbe, OnModuleDestroy {
  public readonly name = 'milvus';
  private readonly enabled: boolean;
  private client: MilvusClient | undefined;
  private readonly clientConfig: ConstructorParameters<typeof MilvusClient>[0];

  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.enabled = config.vectorStore.adapter === 'milvus';
    // SDK 构造器会立即发起异步连接，因此这里只保存配置，不能在应用启动阶段创建客户端。
    this.clientConfig = {
      address: config.milvus.address,
      timeout: config.dependencyHealthTimeoutMs,
      ...(config.milvus.username ? { username: config.milvus.username } : {}),
      ...(config.milvus.password ? { password: config.milvus.password } : {}),
    };
  }

  /** 调用服务端健康 RPC，并显式检查 isHealthy。 */
  public async check(): Promise<DependencyHealth> {
    const startedAt = performance.now();
    if (!this.enabled) {
      return {
        name: this.name,
        status: 'up',
        latencyMs: performance.now() - startedAt,
        message: '当前 Profile 使用内存向量适配器，Milvus 探针不适用',
      };
    }
    try {
      // 惰性创建保证 Milvus 停机时 API 仍能启动并提供 liveness 与诊断信息。
      this.client ??= new MilvusClient(this.clientConfig);
      const result = await this.client.checkHealth();
      if (!result.isHealthy) throw new Error('milvus reported unhealthy');
      return { name: this.name, status: 'up', latencyMs: performance.now() - startedAt };
    } catch {
      // 失败连接不可复用；主动释放并让下一次 readiness 建立全新连接。
      await this.closeClient();
      return {
        name: this.name,
        status: 'down',
        latencyMs: performance.now() - startedAt,
        message: 'Milvus 健康 RPC 失败',
      };
    }
  }

  /** 关闭 gRPC 连接池，避免 Worker 重启时连接泄漏。 */
  public async onModuleDestroy(): Promise<void> {
    await this.closeClient();
  }

  /** SDK 关闭失败不能覆盖原始健康结果或阻塞进程退出。 */
  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    try {
      await client.closeConnection();
    } catch {
      // gRPC 尚未完成握手时 close 也可能失败，此时丢弃实例即可。
    }
  }
}
