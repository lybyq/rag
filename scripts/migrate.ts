/**
 * 以校验和和 PostgreSQL advisory lock 顺序执行正式 migration。
 * 同一数据库只允许一个实例迁移；已执行文件内容变化会立即失败。
 */
import { loadAppConfig } from '@rag/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

const migrationDirectory = resolve(process.cwd(), 'database/migrations');
const migrationNamePattern = /^\d{14}_[a-z0-9_]+\.sql$/;
const advisoryLockKey = 72_410_001;

async function waitForDatabase(pool: Pool): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('PostgreSQL 未就绪');
}

async function applyMigration(
  client: PoolClient,
  name: string,
  sql: string,
  checksum: string,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
      name,
      checksum,
    ]);
    await client.query('COMMIT');
    process.stdout.write(`APPLIED ${name}\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main(): Promise<void> {
  const config = loadAppConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  await waitForDatabase(pool);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [advisoryLockKey]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name varchar(255) PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const appliedChecksums = new Map(applied.rows.map((row) => [row.name, row.checksum]));
    const names = (await readdir(migrationDirectory))
      .filter((name) => migrationNamePattern.test(name))
      .sort();

    for (const name of names) {
      const sql = await readFile(resolve(migrationDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
      const existingChecksum = appliedChecksums.get(name);
      if (existingChecksum && existingChecksum !== checksum) {
        throw new Error(`已执行 migration 被修改：${name}`);
      }
      if (!existingChecksum) await applyMigration(client, name, sql, checksum);
    }
    process.stdout.write(`Database migrations ready: ${names.length} file(s).\n`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
