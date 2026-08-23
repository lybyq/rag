/**
 * API/Worker 实例的 PostgreSQL 心跳上报器。
 *
 * 实例 ID 随进程启动生成；定时 UPSERT 只写服务名、类型和非敏感运行元数据。进程异常退出后
 * 不需要清理记录，Dashboard 根据 last_seen_at 自动判断 DOWN，避免依赖退出钩子。
 *
 * @requirement OPS-005
 */
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

/** 服务实例心跳 Reporter。 */
@Injectable()
export class PostgresServiceHeartbeatReporter implements OnModuleInit, OnModuleDestroy {
  private readonly instanceId = `${process.pid}:${randomUUID()}`;
  private readonly startedAt = new Date();
  private timer?: NodeJS.Timeout;

  public constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 迁移未应用时静默跳过，不能让旧版本滚动发布期间实例启动失败。 */
  public onModuleInit(): void {
    void this.report();
    this.timer = setInterval(() => void this.report(), 10_000);
    this.timer.unref();
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async report(): Promise<void> {
    const kind = this.config.appName.includes('worker') ? 'WORKER' : 'API';
    await this.pool
      .query(
        `INSERT INTO service_instance_heartbeats (
           instance_id,service_name,service_kind,started_at,last_seen_at,metadata
         ) VALUES ($1,$2,$3,$4,now(),$5::jsonb)
         ON CONFLICT (instance_id) DO UPDATE SET last_seen_at=now(),metadata=EXCLUDED.metadata`,
        [
          this.instanceId,
          this.config.appName,
          kind,
          this.startedAt,
          JSON.stringify({ pid: process.pid, providerProfile: this.config.providerProfile }),
        ],
      )
      .catch(() => undefined);
  }
}
