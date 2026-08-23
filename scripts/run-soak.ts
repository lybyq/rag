/**
 * 24～72 小时 Soak 采样器；只读健康、指标和 Docker stats，并写入指定 D 盘目录。
 * 默认 24 小时，开发验证可传 SOAK_DURATION_MINUTES=2；短测不能冒充正式验收。
 *
 * @requirement OPS-011
 */
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const durationMinutes = Number(process.env.SOAK_DURATION_MINUTES ?? 24 * 60);
const intervalSeconds = Number(process.env.SOAK_INTERVAL_SECONDS ?? 30);
const outputRoot = resolve(process.env.RAG_SOAK_OUTPUT_ROOT ?? 'D:/rag-runtime/soak');
const endpoints = (
  process.env.RAG_SOAK_ENDPOINTS ??
  'http://127.0.0.1:3000/api/v1/health/ready,http://127.0.0.1:3001/api/v1/health/ready'
).split(',');

interface Sample {
  at: string;
  endpoints: Record<string, { ok: boolean; latencyMs: number }>;
  docker: string;
}

async function main(): Promise<void> {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0)
    throw new Error('SOAK_DURATION_MINUTES 必须为正数');
  await mkdir(outputRoot, { recursive: true });
  const file = resolve(outputRoot, `soak-${new Date().toISOString().replaceAll(':', '-')}.ndjson`);
  await writeFile(file, '');
  const deadline = Date.now() + durationMinutes * 60_000;
  let failed = 0;
  while (Date.now() < deadline) {
    const sample: Sample = {
      at: new Date().toISOString(),
      endpoints: {},
      docker: await dockerStats(),
    };
    for (const endpoint of endpoints) {
      const started = performance.now();
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
        sample.endpoints[endpoint] = {
          ok: response.ok,
          latencyMs: Math.round(performance.now() - started),
        };
        if (!response.ok) failed += 1;
      } catch {
        sample.endpoints[endpoint] = {
          ok: false,
          latencyMs: Math.round(performance.now() - started),
        };
        failed += 1;
      }
    }
    await appendFile(file, `${JSON.stringify(sample)}\n`, 'utf8');
    await delay(intervalSeconds * 1_000);
  }
  process.stdout.write(`Soak 完成：${durationMinutes} 分钟，失败探针 ${failed}，证据 ${file}\n`);
  if (failed > 0) process.exitCode = 1;
}

function dockerStats(): Promise<string> {
  return new Promise((resolveResult) => {
    const child = spawn('docker', ['stats', '--no-stream', '--format', '{{json .}}'], {
      shell: false,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', () => resolveResult('docker-stats-unavailable'));
    child.on('close', () => resolveResult(output.trim()));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Soak 失败'}\n`);
  process.exitCode = 1;
});
