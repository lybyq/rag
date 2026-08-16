/** 从数据库事实源读取全局授权版本；任何 ACL 改变都会递增它。 */
import { Inject, Injectable } from '@nestjs/common';
import type { AuthorizationVersionPort } from '@rag/contracts';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

@Injectable()
export class PostgresAuthorizationVersionProvider implements AuthorizationVersionPort {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  public async getCurrentVersion(): Promise<number> {
    const result = await this.pool.query<{ version: string }>(
      'SELECT version::text AS version FROM authorization_state WHERE singleton_id = 1',
    );
    const version = Number(result.rows[0]?.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error('authorization_state 不存在或版本非法');
    }
    return version;
  }
}
