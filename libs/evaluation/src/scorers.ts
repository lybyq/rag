/**
 * 评测与生产可靠性的纯评分器。
 *
 * 输入只有版本化 Case 期望和标准化实际事实，输出确定性分数与失败码；这里不调用 LLM，
 * 因此同一份事实可以在 CI、外网和内网得到完全一致的结果。聚合层同时计算均值和总体方差，
 * 防止少量极差样本被平均值掩盖。
 *
 * @requirement OPS-002
 * @requirement OPS-003
 * @requirement OPS-004
 * @requirement OPS-020
 */
import type {
  EvaluationActual,
  EvaluationCase,
  EvaluationMetric,
  EvaluationMetricName,
} from '@rag/contracts';

/** 单 Case 的可持久化评分输出。 */
export interface EvaluationCaseScore {
  /** 只包含对当前 Case 有意义的指标。 */
  readonly scores: Readonly<Partial<Record<EvaluationMetricName, number>>>;
  /** 稳定失败码供 UI 下钻和 CI 报告聚合。 */
  readonly failureCodes: readonly string[];
  /** 所有适用门禁是否同时通过。 */
  readonly passed: boolean;
}

/** PRD 门槛和补充工程门槛的单一来源。 */
export const EVALUATION_THRESHOLDS: Readonly<
  Record<
    EvaluationMetricName,
    { readonly comparator: 'GTE' | 'LTE' | 'EQ'; readonly value: number }
  >
> = Object.freeze({
  ANSWERABLE_RECALL_AT_40: { comparator: 'GTE', value: 0.95 },
  HIT_AT_5: { comparator: 'GTE', value: 0.88 },
  CITATION_PRECISION: { comparator: 'GTE', value: 0.98 },
  UNSUPPORTED_CLAIM_RATE: { comparator: 'LTE', value: 0.01 },
  REFUSAL_ACCURACY: { comparator: 'GTE', value: 0.9 },
  VERSION_SCOPE_ACCURACY: { comparator: 'GTE', value: 0.98 },
  PERMISSION_LEAK_RATE: { comparator: 'EQ', value: 0 },
  PARSING_ACCURACY: { comparator: 'GTE', value: 0.95 },
  CHUNK_BOUNDARY_ACCURACY: { comparator: 'GTE', value: 0.95 },
  SECURITY_PASS_RATE: { comparator: 'EQ', value: 1 },
  LATENCY_PASS_RATE: { comparator: 'GTE', value: 0.95 },
});

/**
 * 对单 Case 评分。
 * RAG 指标按“应命中文档”计算；权限指标按泄漏率计算，DENY Case 只要返回任何受保护事实即算泄漏。
 */
export function scoreEvaluationCase(
  testCase: EvaluationCase,
  actual: EvaluationActual,
): EvaluationCaseScore {
  const scores: Partial<Record<EvaluationMetricName, number>> = {};
  const failures: string[] = [];
  const expected = testCase.expectation;

  if (expected.expectedDocumentIds.length > 0) {
    const expectedSet = new Set(expected.expectedDocumentIds);
    const top40 = actual.retrievedDocumentIds.slice(0, 40);
    const recalled = new Set(top40.filter((id) => expectedSet.has(id))).size;
    scores.ANSWERABLE_RECALL_AT_40 = recalled / expectedSet.size;
    scores.HIT_AT_5 = actual.retrievedDocumentIds.slice(0, 5).some((id) => expectedSet.has(id))
      ? 1
      : 0;
  }

  if (expected.expectedCitationDocumentIds.length > 0) {
    const allowed = new Set(expected.expectedCitationDocumentIds);
    scores.CITATION_PRECISION =
      actual.citationDocumentIds.length === 0
        ? 0
        : actual.citationDocumentIds.filter((id) => allowed.has(id)).length /
          actual.citationDocumentIds.length;
  }

  if (actual.claims.length > 0) {
    scores.UNSUPPORTED_CLAIM_RATE =
      actual.claims.filter((claim) => !claim.supported).length / actual.claims.length;
  }

  if (
    testCase.dimension === 'REFUSAL' ||
    expected.expectedRoute === 'REJECT' ||
    expected.expectedFinalStatus === 'REJECTED'
  ) {
    scores.REFUSAL_ACCURACY =
      actual.route === expected.expectedRoute && actual.finalStatus === expected.expectedFinalStatus
        ? 1
        : 0;
  }

  if (expected.expectedDocumentIds.length > 0 && actual.citationDocumentIds.length > 0) {
    const validVersions = new Set(expected.expectedDocumentIds);
    scores.VERSION_SCOPE_ACCURACY = actual.citationDocumentIds.every((id) => validVersions.has(id))
      ? 1
      : 0;
  }

  if (expected.expectedAccess) {
    const leaked =
      expected.expectedAccess === 'DENY' &&
      (actual.accessDecision === 'ALLOW' ||
        actual.retrievedDocumentIds.length > 0 ||
        actual.citationDocumentIds.length > 0);
    const incorrectlyDenied =
      expected.expectedAccess === 'ALLOW' && actual.accessDecision !== 'ALLOW';
    scores.PERMISSION_LEAK_RATE = leaked ? 1 : 0;
    if (incorrectlyDenied) failures.push('AUTHORIZATION_FALSE_DENY');
  }

  if (expected.minimumParseCoverage !== undefined) {
    scores.PARSING_ACCURACY = actual.parseCoverage ?? 0;
  }
  if (expected.requireChunkBoundaryPass !== undefined) {
    scores.CHUNK_BOUNDARY_ACCURACY = actual.chunkBoundaryPass === true ? 1 : 0;
  }
  if (testCase.dimension === 'SECURITY') {
    scores.SECURITY_PASS_RATE = actual.securityViolations.length === 0 ? 1 : 0;
  }
  if (expected.maximumLatencyMs !== undefined) {
    scores.LATENCY_PASS_RATE =
      actual.responseLatencyMs !== undefined &&
      actual.responseLatencyMs <= expected.maximumLatencyMs
        ? 1
        : 0;
  }

  if (expected.expectedRoute && actual.route !== expected.expectedRoute) {
    failures.push('EVIDENCE_ROUTE_MISMATCH');
  }
  if (expected.expectedFinalStatus && actual.finalStatus !== expected.expectedFinalStatus) {
    failures.push('FINAL_STATUS_MISMATCH');
  }
  for (const literal of expected.answerMustInclude) {
    if (!actual.claims.some((claim) => normalized(claim.text).includes(normalized(literal)))) {
      failures.push('REQUIRED_LITERAL_MISSING');
    }
  }
  for (const literal of expected.answerMustNotInclude) {
    if (actual.claims.some((claim) => normalized(claim.text).includes(normalized(literal)))) {
      failures.push('FORBIDDEN_LITERAL_PRESENT');
    }
  }

  for (const [name, value] of Object.entries(scores) as [EvaluationMetricName, number][]) {
    if (!passes(value, EVALUATION_THRESHOLDS[name])) failures.push(`${name}_FAILED`);
  }

  return {
    scores,
    failureCodes: [...new Set(failures)].sort(),
    passed: failures.length === 0,
  };
}

/** 把全部 Case 分数聚合为可比较指标；无样本的指标不伪造 0。 */
export function aggregateEvaluationMetrics(
  results: readonly EvaluationCaseScore[],
): readonly EvaluationMetric[] {
  const names = Object.keys(EVALUATION_THRESHOLDS) as EvaluationMetricName[];
  const metrics: EvaluationMetric[] = [];
  for (const name of names) {
    const samples = results
      .map((result) => result.scores[name])
      .filter((value): value is number => value !== undefined);
    if (samples.length === 0) continue;
    const value = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    const variance =
      samples.reduce((sum, sample) => sum + (sample - value) ** 2, 0) / samples.length;
    const threshold = EVALUATION_THRESHOLDS[name];
    metrics.push({
      name,
      value,
      threshold: threshold.value,
      comparator: threshold.comparator,
      passed: passes(value, threshold),
      sampleCount: samples.length,
      variance,
    });
  }
  return metrics;
}

/** 基线比较只报告退化，不把质量提升误判为变化失败。 */
export function compareEvaluationBaseline(
  current: readonly EvaluationMetric[],
  baseline: readonly EvaluationMetric[],
  tolerance = 0.000_001,
): readonly string[] {
  const previous = new Map(baseline.map((metric) => [metric.name, metric]));
  const regressions: string[] = [];
  for (const metric of current) {
    const base = previous.get(metric.name);
    if (!base) continue;
    const regressed =
      metric.comparator === 'LTE'
        ? metric.value > base.value + tolerance
        : metric.value < base.value - tolerance;
    if (regressed) regressions.push(`${metric.name}: ${base.value} -> ${metric.value}`);
  }
  return regressions;
}

function passes(
  value: number,
  threshold: { readonly comparator: 'GTE' | 'LTE' | 'EQ'; readonly value: number },
): boolean {
  if (threshold.comparator === 'GTE') return value >= threshold.value;
  if (threshold.comparator === 'LTE') return value <= threshold.value;
  return Math.abs(value - threshold.value) < Number.EPSILON;
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}
