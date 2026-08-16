/**
 * BullMQ 入库事件 Publisher。
 * Outbox eventId 同时作为 Queue jobId，Outbox 重投不会创建第二个队列任务。
 *
 * @requirement DOC-009
 */
import type { OnModuleDestroy } from '@nestjs/common';
import type { ExternalCallOptions, IngestionEventPublisherPort } from '@rag/application';
import type { AppConfig } from '@rag/config';
import type { OutboxEvent } from '@rag/contracts';
import { Queue, type ConnectionOptions } from 'bullmq';

/** 所有生产者和消费者共享的队列名。 */
export const INGESTION_QUEUE_NAME = 'rag-ingestion';

/** 从 redis:// URL 提取 BullMQ 明确连接选项。 */
export function createBullmqConnectionOptions(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

/** Redis/BullMQ 事件投递 Adapter。 */
export class BullmqIngestionEventPublisher implements IngestionEventPublisherPort, OnModuleDestroy {
  private readonly queue: Queue<OutboxEvent>;

  public constructor(config: AppConfig) {
    this.queue = new Queue<OutboxEvent>(INGESTION_QUEUE_NAME, {
      connection: createBullmqConnectionOptions(config.redisBullmqUrl),
      prefix: 'rag',
    });
    this.queue.on('error', () => undefined);
  }

  /** 等待 Queue.add 完成才允许 Outbox 标记 published。 */
  public async publish(event: OutboxEvent, options: ExternalCallOptions): Promise<void> {
    if (options.signal.aborted) throw options.signal.reason;
    await Promise.race([
      this.queue.add('outbox-event', event, {
        jobId: event.id,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 7 * 86_400, count: 50_000 },
      }),
      rejectWhenAborted(options.signal),
    ]);
  }

  public async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

/** 把 AbortSignal 转成永不成功的 Promise，用于约束队列调用 Deadline。 */
function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
