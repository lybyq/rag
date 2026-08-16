/** 统一关闭共享连接池，避免每个 Repository 各自建立无界连接。 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

@Injectable()
export class PostgresPoolLifecycle implements OnModuleDestroy {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  public async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
