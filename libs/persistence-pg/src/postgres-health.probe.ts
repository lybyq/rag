/**
 * 使用 PostgreSQL 协议执行最小只读查询，证明数据库不仅端口可达而且能够处理 SQL。
 * 该探针不承载业务 Repository；连接池会在进程退出时主动关闭。
 *
 * @requirement BASE-009
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '@rag/config';
import type { DependencyHealth, HealthProbe } from '@rag/contracts';
import { Pool } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

/** PostgreSQL 就绪探针。 */
@Injectable()
export class PostgresHealthProbe implements HealthProbe, OnModuleDestroy {
  public readonly name = 'postgresql';
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  public constructor(@Inject(POSTGRES_POOL) poolOrConfig: Pool | AppConfig) {
    if (poolOrConfig instanceof Pool) {
      this.pool = poolOrConfig;
      this.ownsPool = false;
      return;
    }
    this.pool = new Pool({
      connectionString: poolOrConfig.databaseUrl,
      connectionTimeoutMillis: poolOrConfig.dependencyHealthTimeoutMs,
      max: 2,
    });
    this.ownsPool = true;
  }

  /** 执行不会修改数据的 `SELECT 1` 并记录真实协议耗时。 */
  public async check(): Promise<DependencyHealth> {
    const startedAt = performance.now();
    try {
      await this.pool.query('SELECT 1 AS ready');
      return { name: this.name, status: 'up', latencyMs: performance.now() - startedAt };
    } catch {
      return {
        name: this.name,
        status: 'down',
        latencyMs: performance.now() - startedAt,
        message: 'PostgreSQL 查询失败',
      };
    }
  }

  /** 直接用于脚本/集成测试时自行关闭连接；Nest 共享池由生命周期 Provider 关闭。 */
  public async onModuleDestroy(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
