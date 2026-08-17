/**
 * M03 BullMQ Consumer。
 * Inbox 只去重消息事实；真正的处理幂等由 Job lease、Parse Run 和版本化 derived Key 共同保证。
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
import {
  DOCUMENT_INGESTION_REPOSITORY,
  DocumentProcessingService,
  type DocumentIngestionRepository,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { OutboxEventSchema } from '@rag/contracts';
import { MetricsService } from '@rag/observability';
import { INGESTION_QUEUE_NAME, createBullmqConnectionOptions } from '@rag/persistence-redis';
import { Worker } from 'bullmq';
import { hostname } from 'node:os';

/** Worker 生命周期跟随 Nest 进程，关闭时等待当前任务安全停止。 */
@Injectable()
export class IngestionQueueConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionQueueConsumer.name);
  private worker?: Worker;

  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DOCUMENT_INGESTION_REPOSITORY)
    private readonly repository: DocumentIngestionRepository,
    @Inject(DocumentProcessingService)
    private readonly processing: DocumentProcessingService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public onModuleInit(): void {
    this.worker = new Worker(
      INGESTION_QUEUE_NAME,
      async (job) => {
        const event = OutboxEventSchema.parse(job.data);
        const receiptInserted = await this.repository.consumeQueuedIngestion(
          'ingestion-worker:m03',
          event.id,
          event.aggregateId,
        );
        const workerId = `${hostname()}:${process.pid}:${job.id ?? event.id}`.slice(0, 128);
        const leased = await this.repository.acquireJobLease(
          event.aggregateId,
          workerId,
          this.config.upload.ingestionLeaseSeconds,
        );
        if (!leased) {
          this.metrics.m02OperationsTotal.inc({
            operation: 'queue_consume',
            result: receiptInserted ? 'not_claimable' : 'duplicate',
          });
          return;
        }
        const stopHeartbeat = this.startLeaseHeartbeat(event.aggregateId, workerId);
        const timer = this.metrics.m03DurationSeconds.startTimer();
        try {
          const outcome = await this.processing.process(event.aggregateId, workerId);
          this.metrics.m03ProcessingTotal.inc({ result: outcome.toLowerCase() });
          timer({ result: outcome.toLowerCase() });
        } catch (error) {
          this.metrics.m03ProcessingTotal.inc({ result: 'retryable_failure' });
          timer({ result: 'retryable_failure' });
          throw error;
        } finally {
          stopHeartbeat();
        }
        this.metrics.m02OperationsTotal.inc({
          operation: 'queue_consume',
          result: receiptInserted ? 'success' : 'duplicate_recovered',
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

  /** 独立续租不改变业务进度；Provider 阻塞时也不会被 Scheduler 误判成失联。 */
  private startLeaseHeartbeat(jobId: string, workerId: string): () => void {
    const intervalMs = Math.max(1_000, Math.floor(this.config.upload.ingestionLeaseSeconds * 333));
    const timer = setInterval(() => {
      void this.repository
        .renewJobLease(jobId, workerId, this.config.upload.ingestionLeaseSeconds)
        .then((renewed) => {
          if (!renewed) this.logger.warn({ jobId }, '任务 lease 续租失败，当前结果将禁止提交');
        })
        .catch((error: unknown) => {
          this.logger.error(
            { jobId, error: error instanceof Error ? error.message : 'unknown' },
            '任务 lease 续租异常',
          );
        });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
