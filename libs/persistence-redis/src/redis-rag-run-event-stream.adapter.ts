/**
 * M06 Redis Stream、一次性 Ticket 与跨实例取消广播 Adapter。
 *
 * Stream ID 固定为 `${sequence}-0`，PG Outbox 重投时 Lua 会幂等忽略已存在序号，
 * 并拒绝同一 Stream 中的序号倒退。Ticket 使用随机值的 SHA-256 作为 Redis Key 且 GET+DEL 原子兑换。
 *
 * @requirement RUN-007
 * @requirement RUN-008
 * @requirement RUN-009
 * @requirement RUN-010
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type {
  RagRunCancellationPort,
  RagRunEventStreamPort,
  RagRunStreamPage,
  RunStreamTicketBinding,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { RagRunEventSchema, type RagRunEvent } from '@rag/contracts';
import Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

const appendScript = `
local current = redis.call('GET', KEYS[2])
local incoming = tonumber(ARGV[1])
if current and tonumber(current) >= incoming then
  return 'DUPLICATE'
end
if current and tonumber(current) + 1 ~= incoming then
  return redis.error_reply('RUN_EVENT_SEQUENCE_GAP')
end
redis.call('XADD', KEYS[1], ARGV[1] .. '-0',
  'eventId', ARGV[2], 'runId', ARGV[3], 'sequence', ARGV[1],
  'schemaVersion', ARGV[4], 'eventType', ARGV[5],
  'payload', ARGV[6], 'occurredAt', ARGV[7])
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[8])
redis.call('EXPIRE', KEYS[1], ARGV[8])
redis.call('XTRIM', KEYS[1], 'MAXLEN', '~', ARGV[9])
return 'APPENDED'
`;

const redeemTicketScript = `
local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value
`;

/** Redis M06 Adapter，同时持有本进程 AbortController 注册表。 */
@Injectable()
export class RedisRagRunEventStreamAdapter
  implements RagRunEventStreamPort, RagRunCancellationPort, OnModuleInit, OnModuleDestroy
{
  private readonly client: Redis;
  private readonly subscriber: Redis;
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelChannel = 'rag:run:cancel';

  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const options = {
      lazyConnect: true,
      connectTimeout: config.dependencyHealthTimeoutMs,
      commandTimeout: config.dependencyHealthTimeoutMs,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    } as const;
    this.client = new Redis(config.redisCacheUrl, options);
    this.subscriber = new Redis(config.redisCacheUrl, options);
    this.client.on('error', () => undefined);
    this.subscriber.on('error', () => undefined);
  }

  /** 启动取消订阅；Redis 不可用时由健康检查阻止 readiness。 */
  public async onModuleInit(): Promise<void> {
    await this.ensureConnected(this.subscriber);
    await this.subscriber.subscribe(this.cancelChannel);
    this.subscriber.on('message', (_channel, value) => {
      try {
        const parsed = JSON.parse(value) as { runId?: unknown };
        if (typeof parsed.runId === 'string') this.cancel(parsed.runId, '跨实例取消广播');
      } catch {
        // 非法广播不允许中止任意 Run；也不把原始消息写日志。
      }
    });
  }

  /** 精确 sequence 幂等追加，并为 Stream 与序号 Key 设置相同 TTL。 */
  public async append(
    event: RagRunEvent,
    retentionSeconds: number,
    maxLength: number,
  ): Promise<void> {
    await this.ensureConnected(this.client);
    await this.client.eval(
      appendScript,
      2,
      streamKey(event.runId),
      sequenceKey(event.runId),
      String(event.sequence),
      event.eventId,
      event.runId,
      String(event.schemaVersion),
      event.eventType,
      JSON.stringify(event.payload),
      event.occurredAt,
      String(retentionSeconds),
      String(maxLength),
    );
    if (event.eventType === 'run.cancel_requested' || event.eventType === 'run.expired') {
      await this.client.publish(this.cancelChannel, JSON.stringify({ runId: event.runId }));
    }
  }

  /** 从 Last-Event-ID 对应 sequence 之后读取，保持 Redis Stream 原始顺序。 */
  public async read(
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<RagRunStreamPage> {
    await this.ensureConnected(this.client);
    const key = streamKey(runId);
    const exists = (await this.client.exists(key)) === 1;
    if (!exists) return { items: [], nextSequence: afterSequence, exists: false };
    const rows = await this.client.xrange(key, `(${afterSequence}-0`, '+', 'COUNT', limit);
    const items = rows.map(([, fields]) => parseEventFields(fields));
    return {
      items,
      nextSequence: items.at(-1)?.sequence ?? afterSequence,
      exists: true,
    };
  }

  /** Ticket 明文只返回调用者；Redis 仅保存 Ticket Hash 与绑定。 */
  public async issueTicket(binding: RunStreamTicketBinding, ttlSeconds: number): Promise<string> {
    await this.ensureConnected(this.client);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ticket = randomBytes(32).toString('base64url');
      const result = await this.client.set(
        ticketKey(ticket),
        JSON.stringify(binding),
        'EX',
        ttlSeconds,
        'NX',
      );
      if (result === 'OK') return ticket;
    }
    throw new Error('Stream Ticket 生成冲突');
  }

  /** GET+DEL 原子兑换确保 Ticket 最多成功一次。 */
  public async redeemTicket(ticket: string): Promise<RunStreamTicketBinding | undefined> {
    await this.ensureConnected(this.client);
    const value = await this.client.eval(redeemTicketScript, 1, ticketKey(ticket));
    if (typeof value !== 'string') return undefined;
    try {
      const parsed = JSON.parse(value) as RunStreamTicketBinding;
      return typeof parsed.runId === 'string' && typeof parsed.userId === 'string'
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** 获取下游调用共享的 AbortSignal。 */
  public signal(runId: string): AbortSignal {
    let controller = this.controllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(runId, controller);
    }
    return controller.signal;
  }

  /** 幂等中止本进程内的 Run。 */
  public cancel(runId: string, reason: string): void {
    let controller = this.controllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(runId, controller);
    }
    if (!controller.signal.aborted) controller.abort(new Error(reason));
  }

  /** Run 终态后释放 AbortController。 */
  public release(runId: string): void {
    this.controllers.delete(runId);
  }

  public async onModuleDestroy(): Promise<void> {
    this.client.disconnect(false);
    this.subscriber.disconnect(false);
  }

  private async ensureConnected(client: Redis): Promise<void> {
    if (client.status === 'end') throw new Error('Redis client 已结束');
    if (client.status === 'wait') await client.connect();
  }
}

function parseEventFields(fields: string[]): RagRunEvent {
  const record: Record<string, string> = {};
  for (let index = 0; index < fields.length; index += 2) {
    const key = fields[index];
    const value = fields[index + 1];
    if (key && value !== undefined) record[key] = value;
  }
  return RagRunEventSchema.parse({
    eventId: record['eventId'],
    runId: record['runId'],
    sequence: Number(record['sequence']),
    schemaVersion: Number(record['schemaVersion']),
    eventType: record['eventType'],
    payload: JSON.parse(record['payload'] ?? '{}') as unknown,
    occurredAt: record['occurredAt'],
  });
}

function streamKey(runId: string): string {
  return `rag:run:${runId}:events`;
}

function sequenceKey(runId: string): string {
  return `rag:run:${runId}:last-sequence`;
}

function ticketKey(ticket: string): string {
  return `rag:run:stream-ticket:${createHash('sha256').update(ticket).digest('hex')}`;
}
