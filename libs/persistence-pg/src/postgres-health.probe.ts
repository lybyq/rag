/**
 * 使用 PostgreSQL 协议执行最小只读查询，证明数据库不仅端口可达而且能够处理 SQL。
 * 该探针不承载业务 Repository；连接池会在进程退出时主动关闭。
 *
 * @requirement BASE-009
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import type { DependencyHealth, HealthProbe } from '@rag/contracts';
import { Pool } from 'pg';

/** PostgreSQL 就绪探针。 */
@Injectable()
export class PostgresHealthProbe implements HealthProbe, OnModuleDestroy {
  public readonly name = 'postgresql';
  private readonly pool: Pool;

  public constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: config.dependencyHealthTimeoutMs,
      max: 2,
    });
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

  /** 关闭连接池，避免测试和优雅退出时遗留连接。 */
  public async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
