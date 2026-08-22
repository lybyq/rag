/**
 * M06 PostgreSQL Run Event Outbox 到 Redis Stream 的可靠发布器。
 *
 * PG 按 Run 分配 sequence；Redis Adapter 用精确 sequence 幂等 XADD。
 * Publisher 只在 Redis 确认后标记 published，崩溃重投不会制造第二个顺序事件。
 *
 * @requirement RUN-007
 * @requirement RUN-009
 * @requirement RUN-011
 */
import type { RagRunEventStreamPort, RagRunRepository } from './rag-run.ports';

/** Outbox 发布资源、租约和 Stream 保留配置。 */
export interface RagRunEventPublisherConfig {
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly retentionSeconds: number;
  readonly maxLength: number;
}

/** 单轮 Outbox 发布统计。 */
export interface RagRunEventPublishResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  /** 每条成功事件从 PG occurredAt 到 Redis 确认的秒数，供 Adapter 层写低基数 Histogram。 */
  readonly publishLagSeconds: readonly number[];
}

/** 可靠 Run Event 发布服务。 */
export class RagRunEventPublisherService {
  public constructor(
    private readonly repository: RagRunRepository,
    private readonly stream: RagRunEventStreamPort,
    private readonly config: RagRunEventPublisherConfig,
  ) {}

  /** 发布一批；单条失败不阻塞其他 Run，失败事件有限退避后重试。 */
  public async publishBatch(workerId: string): Promise<RagRunEventPublishResult> {
    const events = await this.repository.claimEventOutbox(
      workerId,
      this.config.batchSize,
      this.config.leaseSeconds,
    );
    let published = 0;
    let failed = 0;
    const publishLagSeconds: number[] = [];
    for (const event of events) {
      try {
        await this.stream.append(event, this.config.retentionSeconds, this.config.maxLength);
        await this.repository.markEventPublished(event.eventId, workerId);
        published += 1;
        publishLagSeconds.push(
          Math.max(0, (Date.now() - new Date(event.occurredAt).getTime()) / 1_000),
        );
      } catch {
        await this.repository.releaseEvent(
          event.eventId,
          workerId,
          'REDIS_STREAM_UNAVAILABLE',
          Math.min(300, 2 ** Math.min(event.attempts, 8)),
        );
        failed += 1;
      }
    }
    return { claimed: events.length, published, failed, publishLagSeconds };
  }
}
