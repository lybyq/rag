/**
 * M06 Run Event Outbox、Deadline 与正文保留期调度器。
 * 单进程不重入，数据库 SKIP LOCKED 支持多个内网副本横向运行。
 *
 * @requirement RUN-005
 * @requirement RUN-007
 * @requirement RUN-014
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { RagRunEventPublisherService, RagRunMaintenanceService } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { MetricsService } from '@rag/observability';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** 同时驱动高频事件发布和低频维护。 */
@Injectable()
export class RunEventScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunEventScheduler.name);
  private readonly workerId = `${hostname()}:run-events:${randomUUID()}`.slice(0, 128);
  private publishTimer?: NodeJS.Timeout;
  private maintenanceTimer?: NodeJS.Timeout;
  private publishing = false;
  private maintaining = false;

  public constructor(
    @Inject(RagRunEventPublisherService) private readonly publisher: RagRunEventPublisherService,
    @Inject(RagRunMaintenanceService) private readonly maintenance: RagRunMaintenanceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public onModuleInit(): void {
    this.publishTimer = setInterval(() => void this.publishTick(), 200);
    this.publishTimer.unref();
    this.maintenanceTimer = setInterval(
      () => void this.maintenanceTick(),
      this.config.run.maintenanceIntervalSeconds * 1_000,
    );
    this.maintenanceTimer.unref();
    void this.publishTick();
    void this.maintenanceTick();
  }

  public onModuleDestroy(): void {
    if (this.publishTimer) clearInterval(this.publishTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
  }

  private async publishTick(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    try {
      const result = await this.publisher.publishBatch(this.workerId);
      for (const lagSeconds of result.publishLagSeconds) {
        this.metrics.m06EventPublishLagSeconds.observe(lagSeconds);
      }
      if (result.published > 0) {
        this.metrics.m06OperationsTotal.inc(
          { operation: 'event_publish', result: 'success' },
          result.published,
        );
      }
      if (result.failed > 0) {
        this.metrics.m06OperationsTotal.inc(
          { operation: 'event_publish', result: 'failure' },
          result.failed,
        );
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : 'unknown' },
        'M06 Run Event 发布轮次失败',
      );
    } finally {
      this.publishing = false;
    }
  }

  private async maintenanceTick(): Promise<void> {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      const result = await this.maintenance.runOnce(this.config.run.maintenanceBatchSize);
      if (result.expiredRuns > 0) {
        this.metrics.m06OperationsTotal.inc(
          { operation: 'deadline_expire', result: 'success' },
          result.expiredRuns,
        );
      }
      if (result.redactedContents > 0) {
        this.metrics.m06OperationsTotal.inc(
          { operation: 'content_cleanup', result: 'success' },
          result.redactedContents,
        );
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : 'unknown' },
        'M06 Run 维护轮次失败',
      );
    } finally {
      this.maintaining = false;
    }
  }
}
