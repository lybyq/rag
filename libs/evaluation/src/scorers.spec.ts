/** @requirement OPS-002 @requirement OPS-004 */
import type { EvaluationActual, EvaluationCase } from '@rag/contracts';
import {
  aggregateEvaluationMetrics,
  compareEvaluationBaseline,
  scoreEvaluationCase,
} from './scorers';

const documentId = '00000000-0000-4000-8000-000000000011';

function testCase(overrides: Partial<EvaluationCase> = {}): EvaluationCase {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    datasetId: '00000000-0000-4000-8000-000000000002',
    ordinal: 1,
    externalKey: 'case-1',
    title: '命中并引用正确版本',
    dimension: 'RETRIEVAL',
    question: '制度版本是什么？',
    requestedSpaceIds: ['00000000-0000-4000-8000-000000000003'],
    expectation: {
      expectedDocumentIds: [documentId],
      expectedChunkIds: [],
      expectedCitationDocumentIds: [documentId],
      answerMustInclude: ['2026'],
      answerMustNotInclude: ['2024'],
      expectedRoute: 'ANSWER',
      expectedFinalStatus: 'ANSWERED',
      expectedAccess: 'ALLOW',
      maximumLatencyMs: 8_000,
    },
    tags: ['golden'],
    hasFixtureActual: false,
    createdAt: '2026-08-23T00:00:00.000Z',
    ...overrides,
  };
}

function actual(overrides: Partial<EvaluationActual> = {}): EvaluationActual {
  return {
    retrievedDocumentIds: [documentId],
    retrievedChunkIds: ['chunk-1'],
    citationDocumentIds: [documentId],
    claims: [{ text: '当前版本是 2026 版', supported: true }],
    route: 'ANSWER',
    finalStatus: 'ANSWERED',
    accessDecision: 'ALLOW',
    securityViolations: [],
    responseLatencyMs: 2_000,
    ...overrides,
  };
}

describe('[OPS-002] evaluation scorers', () => {
  it('同时计算检索、引用、Claim、权限、版本和延迟指标', () => {
    const result = scoreEvaluationCase(testCase(), actual());
    expect(result.passed).toBe(true);
    expect(result.scores).toMatchObject({
      ANSWERABLE_RECALL_AT_40: 1,
      HIT_AT_5: 1,
      CITATION_PRECISION: 1,
      UNSUPPORTED_CLAIM_RATE: 0,
      VERSION_SCOPE_ACCURACY: 1,
      PERMISSION_LEAK_RATE: 0,
      LATENCY_PASS_RATE: 1,
    });
  });

  it.each([
    ['PARSING', { minimumParseCoverage: 0.95 }, { parseCoverage: 1 }, 'PARSING_ACCURACY'],
    [
      'CHUNKING',
      { requireChunkBoundaryPass: true },
      { chunkBoundaryPass: true },
      'CHUNK_BOUNDARY_ACCURACY',
    ],
    ['SECURITY', {}, { securityViolations: [] }, 'SECURITY_PASS_RATE'],
  ] as const)('覆盖 %s 专项评分器', (dimension, expectation, actualPatch, metric) => {
    const result = scoreEvaluationCase(
      testCase({
        dimension,
        question: undefined,
        requestedSpaceIds: [],
        expectation: {
          expectedDocumentIds: [],
          expectedChunkIds: [],
          expectedCitationDocumentIds: [],
          answerMustInclude: [],
          answerMustNotInclude: [],
          ...expectation,
        },
      }),
      actual({
        retrievedDocumentIds: [],
        citationDocumentIds: [],
        claims: [],
        ...(actualPatch as Partial<EvaluationActual>),
      }),
    );
    expect(result.scores[metric]).toBe(1);
  });

  it('拒绝权限泄漏并返回稳定失败码', () => {
    const result = scoreEvaluationCase(
      testCase({
        dimension: 'AUTHORIZATION',
        expectation: {
          expectedDocumentIds: [],
          expectedChunkIds: [],
          expectedCitationDocumentIds: [],
          answerMustInclude: [],
          answerMustNotInclude: [],
          expectedAccess: 'DENY',
        },
      }),
      actual({ accessDecision: 'ALLOW' }),
    );
    expect(result.passed).toBe(false);
    expect(result.scores.PERMISSION_LEAK_RATE).toBe(1);
    expect(result.failureCodes).toContain('PERMISSION_LEAK_RATE_FAILED');
  });

  it('聚合均值、方差并识别相对基线退化', () => {
    const good = scoreEvaluationCase(testCase(), actual());
    const bad = scoreEvaluationCase(
      testCase(),
      actual({ retrievedDocumentIds: [], citationDocumentIds: [], responseLatencyMs: 9_000 }),
    );
    const current = aggregateEvaluationMetrics([good, bad]);
    const baseline = aggregateEvaluationMetrics([good, good]);
    expect(current.find((item) => item.name === 'HIT_AT_5')).toMatchObject({
      value: 0.5,
      variance: 0.25,
      passed: false,
    });
    expect(compareEvaluationBaseline(current, baseline)).toContain('HIT_AT_5: 1 -> 0.5');
  });
});
