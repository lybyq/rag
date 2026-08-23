/**
 * 基于在线 Redis 的分布式固定窗口限流与并发租约 Adapter。
 *
 * Lua 在同一个 Redis 分片内完成计数、过期租约清理与新租约登记，避免多个 API 实例
 * 各自限流造成总并发突破。这里不理解用户或空间，只接收上层已经脱敏的键。
 * BullMQ 使用另一条 REDIS_BULLMQ_URL，因此在线问答与离线入库不会争用同一连接池。
 *
 * @requirement OPS-007
 * @requirement OPS-009
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { TrafficControlDecision, TrafficControlPort } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

const ACQUIRE_SCRIPT = `
local rate = redis.call('INCR', KEYS[1])
if rate == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if rate > tonumber(ARGV[2]) then
  local ttl = redis.call('TTL', KEYS[1])
  return {0, 'RATE', math.max(ttl, 1)}
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
local active = redis.call('ZCARD', KEYS[2])
if active >= tonumber(ARGV[4]) then
  return {0, 'CONCURRENCY', math.max(tonumber(ARGV[5]), 1)}
end
redis.call('ZADD', KEYS[2], ARGV[3] + tonumber(ARGV[5]) * 1000, ARGV[6])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]) + 5)
redis.call('SET', KEYS[3], KEYS[2], 'EX', ARGV[5])
return {1, ARGV[6], 0}
`;

const RELEASE_SCRIPT = `
local activeKey = redis.call('GET', KEYS[1])
if not activeKey then return 0 end
redis.call('ZREM', activeKey, ARGV[1])
redis.call('DEL', KEYS[1])
return 1
`;

/** Redis 流控实现；连接失败向上抛出，由 HTTP 层按 fail-closed 转换稳定错误。 */
@Injectable()
export class RedisTrafficControlAdapter implements TrafficControlPort, OnModuleDestroy {
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

  /** 原子申请一个维度的速率配额和并发租约。 */
  public async acquire(
    request: Parameters<TrafficControlPort['acquire']>[0],
  ): Promise<TrafficControlDecision> {
    await this.ensureConnected();
    const leaseId = randomUUID();
    const namespace = `rag:traffic:${request.bucket}:${request.key}`;
    const raw = (await this.client.eval(
      ACQUIRE_SCRIPT,
      3,
      `${namespace}:rate`,
      `${namespace}:active`,
      `rag:traffic:lease:${leaseId}`,
      request.rateWindowSeconds,
      request.rateLimit,
      Date.now(),
      request.concurrencyLimit,
      request.leaseSeconds,
      leaseId,
    )) as [number, string, number];
    if (Number(raw[0]) === 1) return { allowed: true, leaseId };
    return {
      allowed: false,
      reason: raw[1] === 'RATE' ? 'RATE' : 'CONCURRENCY',
      retryAfterSeconds: Math.max(1, Number(raw[2])),
    };
  }

  /** 请求完成、取消或报错都必须释放租约；重复释放安全返回。 */
  public async release(leaseId: string): Promise<void> {
    await this.ensureConnected();
    await this.client.eval(RELEASE_SCRIPT, 1, `rag:traffic:lease:${leaseId}`, leaseId);
  }

  public onModuleDestroy(): void {
    this.client.disconnect(false);
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'end') throw new Error('在线 Redis 流控连接已结束');
    if (this.client.status === 'wait') await this.client.connect();
  }
}
