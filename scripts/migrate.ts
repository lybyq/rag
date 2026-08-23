/**
 * 以校验和和 PostgreSQL advisory lock 顺序执行正式 migration。
 * 同一数据库只允许一个实例迁移；已执行文件内容变化会立即失败。
 */
import { loadAppConfig, loadProfileEnvironment } from '@rag/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

const migrationDirectory = resolve(process.cwd(), 'database/migrations');
const migrationNamePattern = /^\d{14}_[a-z0-9_]+\.sql$/;
const advisoryLockKey = 72_410_001;

/**
 * 语义化改名前已经执行过的迁移校验和。
 *
 * 迁移文件名属于部署事实，不能因为工程目录改名就让已部署数据库重复执行 DDL。这里不依赖旧代号
 * 或旧文件名：同一时间戳下，只要数据库记录的校验和与改名前内容完全一致，就将它识别为同一迁移。
 * 新数据库只会写入新的语义化文件名；旧数据库则继续保留原审计记录，不篡改历史。
 */
const legacyChecksums = new Map<string, string>([
  [
    '20260816090000_identity_access_and_knowledge_spaces.sql',
    'd9b665858ff78898a5e1c4233c1abd73b17cb24e6528e764c5846834cf71e897',
  ],
  [
    '20260816130000_document_ingestion.sql',
    'a0d05faac2f5a7c33133c4b116dd202e3d6a7f3bd19a82d1304fe799864c1aba',
  ],
  [
    '20260817100000_file_security_parsing.sql',
    '36aaa84d50080223417f21b2daf924af79a8128263c213d05088e2a3fb502235',
  ],
  [
    '20260818100000_knowledge_processing.sql',
    '468ab7ed81b499abd827874556a0f70ac4a53cb027a383b7e42fb5c68a642111',
  ],
  [
    '20260821110000_provider_profile_run_snapshot.sql',
    'ac3970eddb5498553e8351a6b5b96fd639fd902958570929abd980f9dcd31252',
  ],
  [
    '20260822120000_indexing_and_publication.sql',
    '78cd27903e44ba1daadd5ffcb4d7eca2bb3b96d928235f08babaa4b78e4274a5',
  ],
  [
    '20260822123000_repeatable_space_outbox.sql',
    '2fe185df37128454ba5c1f78e115c586a8dfa50d6ecf97fccd8004da6caa629d',
  ],
  [
    '20260822130000_profile_rollout_workflow.sql',
    'f4992b95782d3acf54b0f5ca548d32a1ee902996c865d3c3171c08795fa7e12a',
  ],
  [
    '20260822133000_outbox_idempotency_keys.sql',
    '6788e6dfbe1abfc6a4f9fa5c2dc3cb71e68040ecd16233e13724be2b13f1e403',
  ],
  [
    '20260823100000_conversations_and_runs.sql',
    '42b185c4e503cab2a1081f0427f60a4f48eb3cde7257e9cb005e7c359976cd85',
  ],
  [
    '20260823110000_conversation_state_version_and_sources.sql',
    '53c2083fc259b7393a9c4b512052db5ce581967a467d9aaf07f38ff8bbf57f63',
  ],
  [
    '20260823120000_conversation_summary_hash.sql',
    '8fe334d05625b8613409254d4f65a83395683d3b78012ceaad7f97bc03249d85',
  ],
  [
    '20260823130000_conversation_summary_retention.sql',
    'f6a11093b864c0b865c8e84885ed7ddaa352a16662626dab92299c1ae0ec663b',
  ],
  [
    '20260824100000_hybrid_retrieval.sql',
    'b70008fb31aa1b7e6976488b280557c749906368242e98ae6e1ff8a517c0b2f5',
  ],
]);

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
  const config = loadAppConfig(loadProfileEnvironment(process.env));
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
      if (existingChecksum === checksum) continue;

      const timestamp = name.slice(0, 14);
      const legacyChecksum = legacyChecksums.get(name);
      const hasCompatibleLegacyRecord =
        legacyChecksum !== undefined &&
        applied.rows.some(
          (row) => row.name.startsWith(`${timestamp}_`) && row.checksum === legacyChecksum,
        );
      if (hasCompatibleLegacyRecord) continue;
      if (existingChecksum) throw new Error(`已执行 migration 被修改：${name}`);
      await applyMigration(client, name, sql, checksum);
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
