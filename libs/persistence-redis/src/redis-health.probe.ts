/**
 * 分别检查在线缓存 Redis 与 BullMQ Redis，防止“一个 Redis 正常”掩盖另一条链路故障。
 *
 * @requirement BASE-009
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import type { DependencyHealth, HealthProbe } from '@rag/contracts';
import Redis from 'ioredis';

/** 可复用的 Redis PING 探针基类。 */
abstract class RedisHealthProbe implements HealthProbe, OnModuleDestroy {
  protected client: Redis;
  private readonly url: string;
  private readonly timeoutMs: number;

  protected constructor(
    public readonly name: string,
    url: string,
    timeoutMs: number,
  ) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.client = this.createClient();
  }

  /** 创建关闭自动重试的新客户端，让重试节奏完全由 readiness 调用控制。 */
  private createClient(): Redis {
    const client = new Redis(this.url, {
      lazyConnect: true,
      connectTimeout: this.timeoutMs,
      commandTimeout: this.timeoutMs,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    // ioredis 即使命令 Promise 已被 catch 仍会发出 error 事件；探针通过结构化结果报告失败。
    client.on('error', () => undefined);
    return client;
  }

  /** 连接并发送 PING；断线后允许下一次健康检查重新连接。 */
  public async check(): Promise<DependencyHealth> {
    const startedAt = performance.now();
    try {
      // ioredis 进入 end 后不能再次 connect，必须替换实例才能在 Redis 恢复后重新就绪。
      if (this.client.status === 'end') this.client = this.createClient();
      if (this.client.status === 'wait') {
        await this.client.connect();
      }
      const response = await this.client.ping();
      if (response !== 'PONG') throw new Error('unexpected redis response');
      return { name: this.name, status: 'up', latencyMs: performance.now() - startedAt };
    } catch {
      return {
        name: this.name,
        status: 'down',
        latencyMs: performance.now() - startedAt,
        message: 'Redis PING 失败',
      };
    }
  }

  /** 退出时立即关闭连接，不等待网络。 */
  public onModuleDestroy(): void {
    this.client.disconnect(false);
  }
}

/** 在线缓存与 Stream Redis 就绪探针。 */
@Injectable()
export class RedisCacheHealthProbe extends RedisHealthProbe {
  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super('redis-cache', config.redisCacheUrl, config.dependencyHealthTimeoutMs);
  }
}

/** 离线 BullMQ Redis 就绪探针。 */
@Injectable()
export class RedisBullmqHealthProbe extends RedisHealthProbe {
  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super('redis-bullmq', config.redisBullmqUrl, config.dependencyHealthTimeoutMs);
  }
}
