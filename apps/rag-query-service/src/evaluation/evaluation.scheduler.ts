/**
 * 评测 Case 和运行聚合的轻量数据库调度器。
 *
 * setInterval 只负责触发有限批处理；并发互斥在实例内由 inFlight 保证，跨实例由 PostgreSQL
 * 租约保证。定时器不会保存业务状态，重启后继续从数据库事实恢复。
 *
 * @requirement OPS-004
 * @requirement OPS-009
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { EvaluationWorkerService } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { randomUUID } from 'node:crypto';

/** Query Service 内的评测调度器。 */
@Injectable()
export class EvaluationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly workerId = `evaluation:${process.pid}:${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private inFlight = false;

  public constructor(
    @Inject(EvaluationWorkerService) private readonly worker: EvaluationWorkerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 启动后立即处理一次，随后按配置周期执行。 */
  public onModuleInit(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.evaluation.workerIntervalMs);
    this.timer.unref();
  }

  /** 停止新 Tick；正在执行的数据库事务会自然完成或由租约恢复。 */
  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.worker.process(this.workerId);
    } finally {
      this.inFlight = false;
    }
  }
}
