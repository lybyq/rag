/**
 * 发布前读取真实评测运行，拒绝未完成、任一指标未过线或存在基线回归的版本。
 * CI 只传 runId，不接触模型密钥；认证由短期 Bearer Token 或受信 Header 提供。
 *
 * @requirement OPS-004
 * @requirement OPS-019
 * @requirement OPS-020
 */
import { createApiEnvelopeSchema, EvaluationRunDetailSchema } from '@rag/contracts';
const runId = process.env.RELEASE_EVALUATION_RUN_ID ?? '';
const platformUrl = process.env.RAG_PLATFORM_URL ?? 'http://127.0.0.1:3000/api/v1';

async function main(): Promise<void> {
  if (!runId) throw new Error('缺少 RELEASE_EVALUATION_RUN_ID');
  const response = await fetch(`${platformUrl}/evaluation/runs/${encodeURIComponent(runId)}`, {
    headers: headers(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`评测详情读取失败：HTTP ${response.status}`);
  const parsed = createApiEnvelopeSchema(EvaluationRunDetailSchema).parse(await response.json());
  const detail = parsed.data;
  if (detail.run.status !== 'COMPLETED') throw new Error(`评测未完成：${detail.run.status}`);
  const failed = detail.run.metrics.filter((metric) => !metric.passed);
  if (failed.length > 0)
    throw new Error(`指标未过线：${failed.map((item) => item.name).join(', ')}`);
  if (detail.regressions.length > 0)
    throw new Error(`存在基线回归：${detail.regressions.join('；')}`);
  process.stdout.write(`Release gate passed: ${runId}\n`);
}

function headers(): Record<string, string> {
  const value: Record<string, string> = { accept: 'application/json' };
  if (process.env.RAG_BEARER_TOKEN) value.authorization = `Bearer ${process.env.RAG_BEARER_TOKEN}`;
  if (process.env.RAG_MOCK_PRESET) value['x-rag-mock-user'] = process.env.RAG_MOCK_PRESET;
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : '发布门禁失败'}\n`);
  process.exitCode = 1;
});
