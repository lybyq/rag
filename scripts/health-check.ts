/** 对本地四类基础设施执行真实协议检查，而不只判断端口是否打开。 */
import { loadAppConfig, loadProfileEnvironment } from '@rag/config';
import { MilvusHealthProbe } from '@rag/persistence-milvus';
import { MinioHealthProbe } from '@rag/persistence-minio';
import { PostgresHealthProbe } from '@rag/persistence-pg';
import { RedisBullmqHealthProbe, RedisCacheHealthProbe } from '@rag/persistence-redis';

const config = loadAppConfig(loadProfileEnvironment(process.env));
const probes = [
  new PostgresHealthProbe(config),
  new RedisCacheHealthProbe(config),
  new RedisBullmqHealthProbe(config),
  new MinioHealthProbe(config),
  new MilvusHealthProbe(config),
] as const;

async function main(): Promise<void> {
  try {
    const results = await Promise.all(probes.map((probe) => probe.check()));
    for (const result of results) {
      const marker = result.status === 'up' ? 'OK' : 'FAIL';
      // 健康脚本是面向开发者的 CLI，允许在终端输出脱敏后的协议结果。
      process.stdout.write(
        `${marker.padEnd(4)} ${result.name.padEnd(14)} ${result.latencyMs.toFixed(1)}ms${result.message ? `  ${result.message}` : ''}\n`,
      );
    }
    if (results.some((result) => result.status === 'down')) process.exitCode = 1;
  } finally {
    await Promise.all([
      probes[0].onModuleDestroy(),
      Promise.resolve(probes[1].onModuleDestroy()),
      Promise.resolve(probes[2].onModuleDestroy()),
      probes[4].onModuleDestroy(),
    ]);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Health check failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
