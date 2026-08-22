/**
 * M05 跨存储周期维护调度器。
 * 每轮只领取有限批次，数据库 lease + SKIP LOCKED 允许多个 Scheduler 安全并行。
 *
 * @requirement IDX-014
 * @requirement IDX-015
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  INDEX_MAINTENANCE_REPOSITORY,
  OBJECT_STORAGE,
  VECTOR_INDEX_PORT,
  IndexMaintenanceService,
  type IndexMaintenanceRepository,
  type ObjectStoragePort,
  type VectorIndexPort,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { MetricsService } from '@rag/observability';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

/** M05 维护调度器；单进程不重入，跨进程由 PG lease 协调。 */
@Injectable()
export class IndexMaintenanceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexMaintenanceScheduler.name);
  private readonly workerId = `${hostname()}:index-maintenance:${randomUUID()}`.slice(0, 128);
  private readonly service: IndexMaintenanceService;
  private timer?: NodeJS.Timeout;
  private running = false;

  public constructor(
    @Inject(INDEX_MAINTENANCE_REPOSITORY)
    private readonly repository: IndexMaintenanceRepository,
    @Inject(VECTOR_INDEX_PORT) vectorIndex: VectorIndexPort,
    @Inject(OBJECT_STORAGE) storage: ObjectStoragePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.service = new IndexMaintenanceService(repository, vectorIndex, storage, {
      requestTimeoutMs: Math.max(config.embedding.requestTimeoutMs, config.milvus.requestTimeoutMs),
      reconcileIntervalSeconds: config.indexing.reconcileIntervalSeconds,
      maxAttempts: config.indexing.maintenanceMaxAttempts,
    });
  }

  public onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    void this.tick();
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tasks = await this.repository.claimMaintenanceTasks(
        this.workerId,
        this.config.indexing.maintenanceBatchSize,
        this.config.indexing.maintenanceLeaseSeconds,
      );
      for (const task of tasks) {
        const outcome = await this.service.process(task, this.workerId);
        this.metrics.m05OperationsTotal.inc({
          operation: task.taskType.toLowerCase(),
          result: outcome.toLowerCase(),
        });
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : 'unknown' },
        'M05 跨存储周期维护失败',
      );
      this.metrics.m05OperationsTotal.inc({ operation: 'maintenance_tick', result: 'failure' });
    } finally {
      this.running = false;
    }
  }
}
