/**
 * Redis 授权缓存。
 * `invalidateAll` 递增命名空间代次，不扫描/删除旧 Key；旧值在短 TTL 后自然回收。
 *
 * @requirement AUTH-012
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { AuthorizationCachePort } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { SpacePermissionSchema, type SpacePermission } from '@rag/contracts';
import Redis from 'ioredis';
import { z } from 'zod';

const CachedPermissionsSchema = z.array(SpacePermissionSchema);

@Injectable()
export class RedisAuthorizationCacheAdapter implements AuthorizationCachePort, OnModuleDestroy {
  private readonly client: Redis;
  private readonly generationKey = 'rag:authz-cache:generation';
  private localGeneration = 0;

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

  /** Redis 故障时返回 miss，回退到 PostgreSQL 当前 ACL，而不是使用不确定旧值。 */
  public async get(key: string): Promise<readonly SpacePermission[] | undefined> {
    try {
      const namespacedKey = await this.namespacedKey(key);
      const value = await this.client.get(namespacedKey);
      if (!value) return undefined;
      const parsed = CachedPermissionsSchema.safeParse(JSON.parse(value) as unknown);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** 缓存写失败不影响授权事实，下一次请求仍会查询 PostgreSQL。 */
  public async set(
    key: string,
    permissions: readonly SpacePermission[],
    ttlSeconds: number,
  ): Promise<void> {
    try {
      const namespacedKey = await this.namespacedKey(key);
      await this.client.set(namespacedKey, JSON.stringify(permissions), 'EX', ttlSeconds);
    } catch {
      // 安全降级为无缓存；不能因为 Redis 故障把权限判断改成允许。
    }
  }

  /** 先更新本进程代次，再尝试广播到 Redis；本进程立即不会命中旧缓存。 */
  public async invalidateAll(): Promise<void> {
    this.localGeneration += 1;
    try {
      await this.ensureConnected();
      await this.client.incr(this.generationKey);
    } catch {
      // 新请求还会携带数据库的新 authzVersion；Redis 恢复后旧 Key 最长 60 秒自然过期。
    }
  }

  public onModuleDestroy(): void {
    this.client.disconnect(false);
  }

  private async namespacedKey(key: string): Promise<string> {
    await this.ensureConnected();
    const remoteGeneration = (await this.client.get(this.generationKey)) ?? '1';
    return `rag:authz-cache:g${remoteGeneration}:l${this.localGeneration}:${key}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'end') throw new Error('Redis client 已结束');
    if (this.client.status === 'wait') await this.client.connect();
  }
}
