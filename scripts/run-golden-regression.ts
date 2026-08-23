/**
 * PR 级关键 Golden Set 的确定性回归入口。
 *
 * 这里复用生产评分器读取版本化 fixture，验证权限零泄漏、检索、引用、拒答、解析、切块和安全门槛。
 * 它不替代连接真实 Provider 的完整评测；完整 Profile/Prompt/Flow 变更仍由异步 Evaluation Run 与
 * release-gate.ts 比较数据库中的真实 Baseline。
 *
 * @requirement OPS-002
 * @requirement OPS-004
 * @requirement OPS-019
 */
import {
  EvaluationActualSchema,
  EvaluationDimensionSchema,
  EvaluationExpectationSchema,
  EvaluationMetricNameSchema,
  EvaluationCaseSchema,
} from '@rag/contracts';
import {
  aggregateEvaluationMetrics,
  compareEvaluationBaseline,
  scoreEvaluationCase,
} from '@rag/evaluation';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const GoldenCaseSchema = z
  .object({
    externalKey: z.string().min(1).max(120),
    title: z.string().min(1).max(240),
    dimension: EvaluationDimensionSchema,
    question: z.string().min(1).max(8_000).optional(),
    requestedSpaceIds: z.array(z.uuid()).max(20).default([]),
    documentVersionId: z.uuid().optional(),
    processingRunId: z.uuid().optional(),
    expectation: EvaluationExpectationSchema,
    tags: z.array(z.string().min(1).max(60)).max(30).default([]),
    actual: EvaluationActualSchema,
  })
  .strict();
const GoldenFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetVersion: z.string().min(1),
    baseline: z.record(EvaluationMetricNameSchema, z.number().finite()),
    cases: z.array(GoldenCaseSchema).min(1),
  })
  .strict();

async function main(): Promise<void> {
  const path = resolve('evaluation/golden/pr-selected.json');
  const golden = GoldenFileSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
  const datasetId = '00000000-0000-4000-8000-000000000010';
  const scored = golden.cases.map((item, index) => {
    const { actual, ...input } = item;
    const testCase = EvaluationCaseSchema.parse({
      ...input,
      id: caseId(index + 1),
      datasetId,
      ordinal: index + 1,
      hasFixtureActual: true,
      createdAt: '2026-08-23T00:00:00.000Z',
    });
    return { externalKey: item.externalKey, score: scoreEvaluationCase(testCase, actual) };
  });
  const failedCases = scored.filter((item) => !item.score.passed);
  const metrics = aggregateEvaluationMetrics(scored.map((item) => item.score));
  const baseline = metrics.map((metric) => ({
    ...metric,
    value: golden.baseline[metric.name],
  }));
  const missingBaseline = metrics.filter((metric) => golden.baseline[metric.name] === undefined);
  const failedMetrics = metrics.filter((metric) => !metric.passed);
  const regressions = compareEvaluationBaseline(metrics, baseline);

  if (missingBaseline.length > 0) {
    throw new Error(
      `Golden Baseline 缺少指标：${missingBaseline.map((item) => item.name).join(', ')}`,
    );
  }
  if (failedCases.length > 0) {
    throw new Error(
      `Golden Case 失败：${failedCases
        .map((item) => `${item.externalKey}[${item.score.failureCodes.join('|')}]`)
        .join(', ')}`,
    );
  }
  if (failedMetrics.length > 0) {
    throw new Error(`Golden 指标未过线：${failedMetrics.map((item) => item.name).join(', ')}`);
  }
  if (regressions.length > 0) throw new Error(`Golden 基线退化：${regressions.join(', ')}`);

  process.stdout.write(
    `Golden regression passed: ${golden.datasetVersion}, ${scored.length} cases, ${metrics.length} metrics\n`,
  );
}

/** 用序号生成 RFC 4122 v4 形状的稳定测试 UUID，避免把运行随机数写进回归报告。 */
function caseId(ordinal: number): string {
  return `00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Golden 回归失败'}\n`);
  process.exitCode = 1;
});
