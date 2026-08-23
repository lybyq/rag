/**
 * Toxiproxy 故障注入器；只允许显式 CHAOS_ACK=staging，避免误伤生产。
 * 支持 Redis、Milvus、模型网络延迟/断连；API/Worker 单实例故障由 Runbook 的编排器命令执行。
 *
 * @requirement OPS-012
 */
const api = process.env.TOXIPROXY_API ?? 'http://127.0.0.1:8474';
const target = process.env.CHAOS_TARGET ?? 'redis';
const mode = process.env.CHAOS_MODE ?? 'latency';
const targets: Record<string, { listen: string; upstream: string }> = {
  redis: {
    listen: '0.0.0.0:18637',
    upstream: process.env.CHAOS_REDIS_UPSTREAM ?? 'redis-cache:6379',
  },
  milvus: {
    listen: '0.0.0.0:19531',
    upstream: process.env.CHAOS_MILVUS_UPSTREAM ?? 'milvus:19530',
  },
  model: {
    listen: '0.0.0.0:18101',
    upstream: process.env.CHAOS_MODEL_UPSTREAM ?? 'host.docker.internal:8101',
  },
};

async function main(): Promise<void> {
  if (process.env.CHAOS_ACK !== 'staging')
    throw new Error('必须设置 CHAOS_ACK=staging，且只能在隔离环境运行');
  const selected = targets[target];
  if (!selected) throw new Error(`未知 CHAOS_TARGET：${target}`);
  await fetch(`${api}/proxies/rag-${target}`, { method: 'DELETE' }).catch(() => undefined);
  await request('/proxies', { name: `rag-${target}`, ...selected, enabled: true });
  const toxic =
    mode === 'down'
      ? {
          name: 'downstream-cut',
          type: 'timeout',
          stream: 'downstream',
          toxicity: 1,
          attributes: { timeout: 1 },
        }
      : {
          name: 'network-latency',
          type: 'latency',
          stream: 'downstream',
          toxicity: 1,
          attributes: { latency: Number(process.env.CHAOS_LATENCY_MS ?? 1500), jitter: 200 },
        };
  await request(`/proxies/rag-${target}/toxics`, toxic);
  process.stdout.write(`已注入 ${target}/${mode}；清理：DELETE ${api}/proxies/rag-${target}\n`);
}

async function request(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${api}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Toxiproxy API 失败：HTTP ${response.status}`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Chaos 失败'}\n`);
  process.exitCode = 1;
});

// 本文件由 tsx 独立执行；显式标记为模块，避免全仓 typecheck 时与其他脚本的 main 重名。
export {};
