/**
 * M02 周期维护器：发布 Outbox 并恢复过期 lease。
 * 每次运行都是有限批次，多个 scheduler 实例依赖 SKIP LOCKED 安全协作。
 *
 * @requirement DOC-009
 * @requirement DOC-016
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  DOCUMENT_INGESTION_REPOSITORY,
  INGESTION_EVENT_PUBLISHER,
  OutboxPublisherService,
  type DocumentIngestionRepository,
  type IngestionEventPublisherPort,
} from '@rag/application';
import { MetricsService } from '@rag/observability';
import { randomUUID } from 'node:crypto';

/** Scheduler 生命周期内复用一个发布器标识，便于排查 outbox 锁归属。 */
@Injectable()
export class IngestionMaintenanceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionMaintenanceScheduler.name);
  private readonly publisher: OutboxPublisherService;
  private timer?: NodeJS.Timeout;
  private running = false;

  public constructor(
    @Inject(DOCUMENT_INGESTION_REPOSITORY) repository: DocumentIngestionRepository,
    @Inject(INGESTION_EVENT_PUBLISHER) publisher: IngestionEventPublisherPort,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.publisher = new OutboxPublisherService(repository, publisher, `scheduler-${randomUUID()}`);
  }

  public onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), 2_000);
    this.timer.unref();
    void this.tick();
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 防止单进程定时器重入；多进程互斥由数据库行锁负责。 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const published = await this.publisher.publishOnce(50);
      const recovered = await this.publisher.recoverExpiredLeases(3);
      if (published > 0) {
        this.metrics.m02OperationsTotal.inc(
          { operation: 'outbox_publish', result: 'success' },
          published,
        );
      }
      if (recovered > 0) {
        this.metrics.m02OperationsTotal.inc(
          { operation: 'lease_recover', result: 'success' },
          recovered,
        );
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : 'unknown scheduler error' },
        'M02 周期维护失败',
      );
    } finally {
      this.running = false;
    }
  }
}
