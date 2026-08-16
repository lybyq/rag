/**
 * M02 BullMQ Consumer。
 * Inbox 收据和当前 M02 等待状态由 Repository 同事务提交，重复投递不会重复制造事实。
 *
 * @requirement DOC-009
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DOCUMENT_INGESTION_REPOSITORY, type DocumentIngestionRepository } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { OutboxEventSchema } from '@rag/contracts';
import { MetricsService } from '@rag/observability';
import { INGESTION_QUEUE_NAME, createBullmqConnectionOptions } from '@rag/persistence-redis';
import { Worker } from 'bullmq';

/** Worker 生命周期跟随 Nest 进程，关闭时等待当前任务安全停止。 */
@Injectable()
export class IngestionQueueConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionQueueConsumer.name);
  private worker?: Worker;

  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DOCUMENT_INGESTION_REPOSITORY)
    private readonly repository: DocumentIngestionRepository,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public onModuleInit(): void {
    this.worker = new Worker(
      INGESTION_QUEUE_NAME,
      async (job) => {
        const event = OutboxEventSchema.parse(job.data);
        const consumed = await this.repository.consumeQueuedIngestion(
          'ingestion-worker:m02',
          event.id,
          event.aggregateId,
        );
        this.metrics.m02OperationsTotal.inc({
          operation: 'queue_consume',
          result: consumed ? 'success' : 'duplicate',
        });
      },
      {
        connection: createBullmqConnectionOptions(this.config.redisBullmqUrl),
        prefix: 'rag',
        concurrency: 4,
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error({ queueJobId: job?.id, error: error.message }, '入库队列任务失败');
    });
    this.worker.on('error', (error) => {
      this.logger.error({ error: error.message }, '入库队列连接异常');
    });
  }

  public async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
