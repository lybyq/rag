/**
 * PostgreSQL、MinIO 与非敏感配置快照的备份/恢复入口。
 * 默认根目录在 D 盘；恢复必须显式 RESTORE_ACK=restore:<backupId>，防止误覆盖。
 * Milvus 不备份为事实源，恢复后由 rebuild-milvus.ts 从 PG/MinIO 重建。
 *
 * @requirement OPS-013
 * @requirement OPS-014
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'backup';
const backupRoot = resolve(process.env.RAG_BACKUP_ROOT ?? 'D:/rag-backups');
const databaseUrl = process.env.DATABASE_URL;
const minioEndpoint = process.env.MINIO_ENDPOINT;
const minioAccessKey = process.env.MINIO_ACCESS_KEY;
const minioSecretKey = process.env.MINIO_SECRET_KEY;
const buckets = (process.env.RAG_BACKUP_BUCKETS ?? 'rag-quarantine,rag-derived')
  .split(',')
  .filter(Boolean);

async function main(): Promise<void> {
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
  if (mode === 'backup') return backup();
  if (mode === 'restore') return restore(process.argv[3]);
  throw new Error('用法：tsx scripts/backup-restore.ts backup|restore <backupId>');
}

async function backup(): Promise<void> {
  const backupId = new Date().toISOString().replaceAll(':', '-');
  const target = resolve(backupRoot, backupId);
  await mkdir(resolve(target, 'minio'), { recursive: true });
  await run(
    'pg_dump',
    ['--format=custom', '--no-owner', `--file=${resolve(target, 'postgres.dump')}`],
    pgEnvironment(databaseUrl!),
  );
  const backedUpBuckets: string[] = [];
  if (minioEndpoint && minioAccessKey && minioSecretKey) {
    const environment = mcEnvironment(minioEndpoint, minioAccessKey, minioSecretKey);
    for (const bucket of buckets) {
      await run(
        'mc',
        ['mirror', '--overwrite', `rag/${bucket}`, resolve(target, 'minio', bucket)],
        environment,
      );
      backedUpBuckets.push(bucket);
    }
  }
  const configFile = process.env.RAG_CONFIG_FILE;
  const configBackupName = configFile ? `config-${basename(configFile)}` : null;
  if (configFile && configBackupName)
    await copyFile(resolve(configFile), resolve(target, configBackupName));
  const manifest = {
    schemaVersion: 1,
    backupId,
    createdAt: new Date().toISOString(),
    database: 'postgres.dump',
    buckets: backedUpBuckets,
    config: configBackupName,
    files: await checksums(target),
  };
  await writeFile(resolve(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  process.stdout.write(`备份完成：${target}\n`);
}

async function restore(backupId: string | undefined): Promise<void> {
  if (!backupId || !/^[0-9T.Z-]+$/.test(backupId)) throw new Error('backupId 非法');
  if (process.env.RESTORE_ACK !== `restore:${backupId}`)
    throw new Error(`恢复会覆盖目标数据，必须设置 RESTORE_ACK=restore:${backupId}`);
  const source = resolve(backupRoot, backupId);
  const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8')) as {
    schemaVersion?: number;
    backupId?: string;
    database?: string;
    buckets?: string[];
    config?: string | null;
    files?: Record<string, string>;
  };
  if (manifest.backupId !== backupId) throw new Error('备份 Manifest 与目录不匹配');
  if (manifest.schemaVersion !== 1 || manifest.database !== 'postgres.dump' || !manifest.files)
    throw new Error('备份 Manifest 版本或字段不受支持');
  await verifyChecksums(source, manifest.files);
  const configTarget = manifest.config ? process.env.RAG_RESTORE_CONFIG_TARGET : undefined;
  if (manifest.config && !configTarget)
    throw new Error('备份包含配置快照，必须设置 RAG_RESTORE_CONFIG_TARGET');
  const manifestBuckets = manifest.buckets ?? [];
  if (manifestBuckets.length > 0 && (!minioEndpoint || !minioAccessKey || !minioSecretKey))
    throw new Error('备份包含 MinIO 数据，但恢复环境没有完整 MinIO 凭据');
  await run(
    'pg_restore',
    ['--clean', '--if-exists', '--no-owner', resolve(source, manifest.database)],
    pgEnvironment(databaseUrl!),
  );
  if (minioEndpoint && minioAccessKey && minioSecretKey) {
    const environment = mcEnvironment(minioEndpoint, minioAccessKey, minioSecretKey);
    for (const bucket of manifestBuckets)
      await run(
        'mc',
        ['mirror', '--overwrite', '--remove', resolve(source, 'minio', bucket), `rag/${bucket}`],
        environment,
      );
  }
  if (manifest.config) {
    await copyFile(resolveContained(source, manifest.config), resolve(configTarget!));
  }
  process.stdout.write('PG/MinIO 恢复完成；下一步运行 rebuild-milvus.ts 并执行固定查询验收。\n');
}

function pgEnvironment(urlValue: string): NodeJS.ProcessEnv {
  const url = new URL(urlValue);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: url.pathname.slice(1),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
}

function mcEnvironment(endpoint: string, accessKey: string, secretKey: string): NodeJS.ProcessEnv {
  const url = new URL(endpoint);
  return {
    ...process.env,
    MC_HOST_rag: `${url.protocol}//${encodeURIComponent(accessKey)}:${encodeURIComponent(secretKey)}@${url.host}`,
  };
}

function run(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      env: environment,
      shell: false,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${command} 退出码 ${code ?? 'unknown'}`)),
    );
  });
}

async function checksums(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile()) {
        const key = relative(root, path).split(sep).join('/');
        result[key] = await digestFile(path);
      }
    }
  }
  await visit(root);
  return result;
}

/** 在任何覆盖动作前逐项验证 Manifest，阻止损坏或被替换的备份进入恢复链路。 */
async function verifyChecksums(root: string, expected: Record<string, string>): Promise<void> {
  for (const [key, digest] of Object.entries(expected)) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Manifest 摘要非法：${key}`);
    const actual = await digestFile(resolveContained(root, key));
    if (actual !== digest) throw new Error(`备份校验失败：${key}`);
  }
}

/** 只允许 Manifest 指向备份目录内部，避免被篡改的相对路径覆盖任意文件。 */
function resolveContained(root: string, key: string): string {
  const target = resolve(root, key);
  const relativeTarget = relative(root, target);
  if (
    !relativeTarget ||
    relativeTarget.startsWith('..') ||
    resolve(root, relativeTarget) !== target
  )
    throw new Error(`备份路径越界：${key}`);
  return target;
}

/** 对大文件进行流式 SHA-256，避免把 PostgreSQL dump 或对象全部读入内存。 */
async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : '备份恢复失败'}\n`);
  process.exitCode = 1;
});
