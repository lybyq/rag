/**
 * 验证已提交/已编辑的 OpenAPI 产物与当前契约真相源一致。
 *
 * 旧脚本在生成后执行 `git diff`，会把当前分支中合法但尚未提交的新接口也判为失败。
 * 本脚本改为比较“本次生成前后”的文件内容：
 * - 内容不变：说明生成文件已经同步；
 * - 内容变化：说明开发者修改了契约却忘记执行生成命令。
 *
 * 这种检查与 Git 暂存状态无关，因此本地脏工作区和 CI 都得到同一种语义。
 *
 * @requirement BASE-004
 * @requirement NFR-012
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const generatedFiles = ['platform-api.json', 'rag-query-service.json'].map((fileName) =>
  resolve(process.cwd(), 'openapi/generated', fileName),
);

/** 文件不存在也属于“生成前状态”，生成后会自然被判定为过期。 */
async function readIfPresent(filePath: string): Promise<string | undefined> {
  return readFile(filePath, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
}

async function main(): Promise<void> {
  const before = await Promise.all(generatedFiles.map(readIfPresent));

  // Windows 不能由 spawnSync 直接可靠执行 .cmd shim，因此通过系统命令解释器启动固定命令。
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm openapi:generate'], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  } else {
    execFileSync('pnpm', ['openapi:generate'], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
  }

  const after = await Promise.all(generatedFiles.map(readIfPresent));
  const changedFiles = generatedFiles.filter((_, index) => before[index] !== after[index]);

  if (changedFiles.length > 0) {
    const relativeFiles = changedFiles.map((filePath) => relative(process.cwd(), filePath));
    throw new Error(
      `OpenAPI 生成文件不是最新状态：${relativeFiles.join(', ')}。请执行 pnpm openapi:generate 后重新提交。`,
    );
  }

  process.stdout.write(`OpenAPI gate passed: ${generatedFiles.length} file(s) are current.\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `OpenAPI gate failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
