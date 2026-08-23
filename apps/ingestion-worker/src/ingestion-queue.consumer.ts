/**
 * 文件解析与OCR/知识加工与质量/索引构建与发布 BullMQ Consumer。
 * 事件类型只负责阶段路由；Inbox、Job lease 和版本化 Run 共同保证崩溃恢复与幂等。
 *
 * @requirement DOC-009
 * @requirement KNO-014
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
  AUTHORIZATION_CACHE,
  DocumentProcessingService,
  IndexingService,
  KnowledgeProcessingService,
  type DocumentIngestionRepository,
  type AuthorizationCachePort,
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
    @Inject(KnowledgeProcessingService)
    private readonly knowledgeProcessing: KnowledgeProcessingService,
    @Inject(IndexingService) private readonly indexing: IndexingService,
    @Inject(AUTHORIZATION_CACHE) private readonly authorizationCache: AuthorizationCachePort,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public onModuleInit(): void {
    this.worker = new Worker(
      INGESTION_QUEUE_NAME,
      async (job) => {
        const event = OutboxEventSchema.parse(job.data);
        const stage = classifyIngestionQueueStage(event.eventType);
        if (stage === 'PROJECTION') {
          // 发布、回滚、废止、撤权都先失效跨实例 Redis 权限缓存，再写消费收据。
          // 若 Redis 失败则不落收据，BullMQ 会重试，避免“事件已消费但旧权限仍可见”。
          if (event.eventType === 'cache.invalidate.space') {
            await this.authorizationCache.invalidateAll();
          }
          await this.repository.recordConsumerReceipt('index-projection-worker', event.id);
          this.metrics.indexingPublicationOperationsTotal.inc({
            operation: 'projection_event',
            result: 'received',
          });
          return;
        }
        if (stage === 'LIFECYCLE') {
          // DOC-009：取消事件用于唤醒其他消费者终止工作；当前 Ingestion Worker 不能把它再次
          // 当作处理命令。只落 Inbox 收据即可停止 BullMQ 重试，业务取消事实已由 PG 事务提交。
          await this.repository.recordConsumerReceipt('ingestion-lifecycle-worker', event.id);
          this.metrics.documentIngestionOperationsTotal.inc({
            operation: 'lifecycle_event',
            result: 'received',
          });
          return;
        }
        const receiptInserted = await this.repository.consumeQueuedIngestion(
          `ingestion-worker:${stage.toLowerCase()}`,
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
          this.metrics.documentIngestionOperationsTotal.inc({
            operation: 'queue_consume',
            result: receiptInserted ? 'not_claimable' : 'duplicate',
          });
          return;
        }
        const stopHeartbeat = this.startLeaseHeartbeat(event.aggregateId, workerId);
        try {
          if (stage === 'DOCUMENT_PARSING') {
            const timer = this.metrics.documentParsingDurationSeconds.startTimer();
            const outcome = await this.processing.process(event.aggregateId, workerId);
            this.metrics.documentParsingOperationsTotal.inc({ result: outcome.toLowerCase() });
            timer({ result: outcome.toLowerCase() });
          } else if (stage === 'KNOWLEDGE_PROCESSING') {
            const timer = this.metrics.knowledgeProcessingDurationSeconds.startTimer();
            const outcome = await this.knowledgeProcessing.process(event.aggregateId, workerId);
            this.metrics.knowledgeProcessingOperationsTotal.inc({ result: outcome.toLowerCase() });
            timer({ result: outcome.toLowerCase() });
          } else {
            const timer = this.metrics.indexingPublicationDurationSeconds.startTimer();
            const outcome = await this.indexing.process(event.aggregateId, workerId);
            this.metrics.indexingPublicationOperationsTotal.inc({
              operation: 'indexing_run',
              result: outcome.toLowerCase(),
            });
            timer({ result: outcome.toLowerCase() });
          }
        } catch (error) {
          if (stage === 'DOCUMENT_PARSING')
            this.metrics.documentParsingOperationsTotal.inc({ result: 'retryable_failure' });
          else if (stage === 'KNOWLEDGE_PROCESSING')
            this.metrics.knowledgeProcessingOperationsTotal.inc({ result: 'failure' });
          else
            this.metrics.indexingPublicationOperationsTotal.inc({
              operation: 'indexing_run',
              result: 'failure',
            });
          throw error;
        } finally {
          stopHeartbeat();
        }
        this.metrics.documentIngestionOperationsTotal.inc({
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

/** 未知阶段必须失败并进入队列失败记录，不能误用 文件解析与OCR/知识加工与质量 处理器消费。 */
export function classifyIngestionQueueStage(
  eventType: string,
):
  | 'DOCUMENT_PARSING'
  | 'KNOWLEDGE_PROCESSING'
  | 'INDEXING_PUBLICATION'
  | 'PROJECTION'
  | 'LIFECYCLE' {
  if (eventType === 'ingestion.requested') return 'DOCUMENT_PARSING';
  if (eventType === 'ingestion.knowledge_processing.requested') return 'KNOWLEDGE_PROCESSING';
  if (eventType === 'ingestion.indexing.requested') return 'INDEXING_PUBLICATION';
  if (eventType === 'ingestion.cancelled') return 'LIFECYCLE';
  if (eventType.startsWith('index.') || eventType === 'cache.invalidate.space') {
    return 'PROJECTION';
  }
  throw new Error(`不支持的入库事件类型：${eventType}`);
}
