/**
 * Outbox 发布与 lease 恢复用例。
 * Publisher 领取数据库事实后才调用消息端口，失败时释放并指数退避。
 *
 * @requirement DOC-009
 * @requirement DOC-016
 */
import type { DocumentIngestionRepository, IngestionEventPublisherPort } from './ingestion.ports';

/** 一次有限批次发布，便于 worker 定时调用和集成测试。 */
export class OutboxPublisherService {
  public constructor(
    private readonly repository: DocumentIngestionRepository,
    private readonly publisher: IngestionEventPublisherPort,
    private readonly workerId: string,
  ) {}

  /** 返回成功发布数量；单条失败不会阻塞同批其他事件。 */
  public async publishOnce(limit = 50): Promise<number> {
    const events = await this.repository.claimOutboxBatch(this.workerId, limit, 30);
    let published = 0;
    for (const event of events) {
      try {
        await this.publisher.publish(event, { signal: AbortSignal.timeout(10_000) });
        await this.repository.markOutboxPublished(event.id);
        published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown publisher error';
        await this.repository.releaseOutboxEvent(event.id, message.slice(0, 500), 10);
      }
    }
    return published;
  }

  /** Scheduler 调用；Repository 通过行锁决定重排队还是转人工等待。 */
  public async recoverExpiredLeases(maxAttempts = 3): Promise<number> {
    return this.repository.recoverExpiredLeases(new Date(), maxAttempts);
  }
}
