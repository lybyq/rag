/** 检查 SQL migration 命名和明显破坏性语句，防止未审查变更进入 CI。 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const migrationDirectory = resolve(process.cwd(), 'database/migrations');
const namePattern = /^\d{14}_[a-z0-9_]+\.sql$/;
const destructivePattern = /\b(DROP\s+(TABLE|COLUMN)|TRUNCATE\s+TABLE)\b/i;

async function main(): Promise<void> {
  const entries = await readdir(migrationDirectory, { withFileTypes: true });
  const sqlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'));

  for (const file of sqlFiles) {
    if (!namePattern.test(file.name)) throw new Error(`Migration 文件名不合规: ${file.name}`);
    const sql = await readFile(resolve(migrationDirectory, file.name), 'utf8');
    if (destructivePattern.test(sql) && !sql.includes('-- reviewed-destructive-change')) {
      throw new Error(`Migration 包含未标记的破坏性操作: ${file.name}`);
    }
  }

  process.stdout.write(`Migration gate passed: ${sqlFiles.length} file(s) checked.\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Migration gate failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
