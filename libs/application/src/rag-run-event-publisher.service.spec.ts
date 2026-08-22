/**
 * M06 PG Outbox 到 Redis Stream 发布器单元门禁。
 * 单条 Redis 故障必须释放租约并继续发布其他 Run，不能让一条坏事件阻塞整批。
 *
 * @requirement RUN-007
 * @requirement RUN-011
 */
import type { RagRunEvent } from '@rag/contracts';
import { RagRunEventPublisherService } from './rag-run-event-publisher.service';
import type { RagRunEventStreamPort, RagRunOutboxEvent, RagRunRepository } from './rag-run.ports';

const first = event('00000000-0000-4000-8000-000000000001', 1, 2);
const second = event('00000000-0000-4000-8000-000000000002', 1, 1);

describe('[RUN-007][RUN-011] RagRunEventPublisherService', () => {
  test('Redis 部分失败会释放对应事件并确认其余事件', async () => {
    const repository = {
      claimEventOutbox: jest.fn().mockResolvedValue([first, second]),
      markEventPublished: jest.fn().mockResolvedValue(undefined),
      releaseEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as RagRunRepository;
    const stream = {
      append: jest
        .fn<Promise<void>, [RagRunEvent, number, number]>()
        .mockRejectedValueOnce(new Error('redis unavailable'))
        .mockResolvedValueOnce(undefined),
    } as unknown as RagRunEventStreamPort;
    const publisher = new RagRunEventPublisherService(repository, stream, {
      batchSize: 20,
      leaseSeconds: 30,
      retentionSeconds: 600,
      maxLength: 1_000,
    });

    await expect(publisher.publishBatch('worker-1')).resolves.toEqual({
      claimed: 2,
      published: 1,
      failed: 1,
      publishLagSeconds: [expect.any(Number)],
    });
    expect(repository.releaseEvent).toHaveBeenCalledWith(
      first.eventId,
      'worker-1',
      'REDIS_STREAM_UNAVAILABLE',
      4,
    );
    expect(repository.markEventPublished).toHaveBeenCalledWith(second.eventId, 'worker-1');
  });
});

function event(eventId: string, sequence: number, attempts: number): RagRunOutboxEvent {
  return {
    eventId,
    runId: `00000000-0000-4000-8000-00000000000${sequence}`,
    sequence,
    schemaVersion: 1,
    eventType: 'run.accepted',
    payload: { status: 'ACCEPTED' },
    occurredAt: '2026-08-22T12:00:00.000Z',
    attempts,
  };
}
