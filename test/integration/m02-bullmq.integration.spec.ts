/**
 * 使用真实 Redis 验证 BullMQ 传输层去重。
 * PostgreSQL Outbox 负责“至少一次”重投，而 eventId 作为 BullMQ jobId 保证同一事件只保留一个队列任务。
 */
import { loadAppConfig } from '@rag/config';
import type { OutboxEvent } from '@rag/contracts';
import {
  BullmqIngestionEventPublisher,
  INGESTION_QUEUE_NAME,
  createBullmqConnectionOptions,
} from '@rag/persistence-redis';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';

const describeWithInfra = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeWithInfra('[DOC-009] M02 BullMQ eventId 去重', () => {
  const config = loadAppConfig(process.env);
  const publisher = new BullmqIngestionEventPublisher(config);
  const queue = new Queue<OutboxEvent>(INGESTION_QUEUE_NAME, {
    connection: createBullmqConnectionOptions(config.redisBullmqUrl),
    prefix: 'rag',
  });

  afterAll(async () => {
    await queue.close();
    await publisher.onModuleDestroy();
  });

  it('同一 Outbox 事件发布两次只生成一个 Redis job', async () => {
    const event: OutboxEvent = {
      id: randomUUID(),
      aggregateType: 'INGESTION_JOB',
      aggregateId: `m02-bullmq-${Date.now()}`,
      eventType: 'INGESTION_QUEUED',
      payload: { source: 'integration-test' },
      occurredAt: new Date().toISOString(),
      publishedAt: null,
      attempts: 0,
    };

    await publisher.publish(event, { signal: AbortSignal.timeout(5_000) });
    await publisher.publish(event, { signal: AbortSignal.timeout(5_000) });

    const storedJob = await queue.getJob(event.id);
    expect(storedJob).toBeDefined();
    expect(storedJob?.id).toBe(event.id);
    expect(storedJob?.data).toEqual(event);

    // 清理时只删除本测试使用的精确 jobId，不触碰开发者队列中的其他任务。
    await storedJob?.remove();
    await expect(queue.getJob(event.id)).resolves.toBeUndefined();
  });
});
