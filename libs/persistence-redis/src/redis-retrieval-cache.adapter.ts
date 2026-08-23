/**
 * M07 查询 Embedding Redis 缓存 Adapter。
 *
 * Key 由 Application 对 Profile、Plan 与权限范围做 SHA-256 后生成，不含问题原文；值由 Zod 校验
 * 模型、版本与 Dense/Sparse 形状。Redis 故障统一降级为 miss，绝不跳过 PostgreSQL 权限复核。
 *
 * @requirement RET-008
 * @requirement RET-013
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { RetrievalCachePort } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { QueryEmbeddingCacheValueSchema, type QueryEmbeddingCacheValue } from '@rag/contracts';
import Redis from 'ioredis';

/** Redis 查询向量缓存；只接受 64 位摘要 Key。 */
@Injectable()
export class RedisRetrievalCacheAdapter implements RetrievalCachePort, OnModuleDestroy {
  private readonly client: Redis;

  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.redisCacheUrl, {
      lazyConnect: true,
      connectTimeout: config.dependencyHealthTimeoutMs,
      commandTimeout: config.dependencyHealthTimeoutMs,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    this.client.on('error', () => undefined);
  }

  /** Schema 错误、过期或 Redis 故障均视为 miss。 */
  public async getQueryEmbedding(key: string): Promise<QueryEmbeddingCacheValue | undefined> {
    assertCacheKey(key);
    try {
      await this.ensureConnected();
      const raw = await this.client.get(`rag:m07:query-embedding:${key}`);
      if (!raw) return undefined;
      const parsed = QueryEmbeddingCacheValueSchema.safeParse(JSON.parse(raw) as unknown);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** 写失败由上层记录降级指标，但不影响本次已取得的向量。 */
  public async setQueryEmbedding(
    key: string,
    value: QueryEmbeddingCacheValue,
    ttlSeconds: number,
  ): Promise<void> {
    assertCacheKey(key);
    const parsed = QueryEmbeddingCacheValueSchema.parse(value);
    await this.ensureConnected();
    await this.client.set(
      `rag:m07:query-embedding:${key}`,
      JSON.stringify(parsed),
      'EX',
      ttlSeconds,
    );
  }

  public onModuleDestroy(): void {
    this.client.disconnect(false);
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'end') throw new Error('Redis client 已结束');
    if (this.client.status === 'wait') await this.client.connect();
  }
}

function assertCacheKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('M07 缓存 Key 必须是 SHA-256');
}
