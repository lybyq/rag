/**
 * 第二轮检索查询判定回归测试。
 *
 * @requirement RET-015
 */
import type { RetrievalPlan } from '@rag/contracts';
import { secondRoundAddsNewQuery } from './query-plan';

describe('[RET-015] bounded retry query', () => {
  it('礼貌词删除后仍等于首轮查询时跳过重复检索', () => {
    expect(secondRoundAddsNewQuery(plan('请问 差旅标准', ['请问 差旅标准', '差旅标准']))).toBe(
      false,
    );
  });

  it('确定性放宽确实产生新文本时允许第二轮', () => {
    expect(secondRoundAddsNewQuery(plan('请问帮我查询差旅标准', ['请问帮我查询差旅标准']))).toBe(
      true,
    );
  });
});

function plan(primaryQuery: string, subQuestions: readonly string[]): RetrievalPlan {
  return {
    route: 'KNOWLEDGE',
    source: 'DETERMINISTIC',
    primaryQuery,
    subQuestions: [...subQuestions],
    exactLiterals: [],
    entities: [],
    filter: {
      clauses: [{ field: 'SPACE_ID', operator: 'IN', value: [] }],
      asOf: '2026-09-13T00:00:00.000Z',
      compilerVersion: 'v1',
      requireManifestMembership: true,
      requireCurrentDocumentVersion: true,
    },
    round: 1,
    profile: {
      profileId: 'test',
      initialTopK: 40,
      candidatePoolTopK: 30,
      finalTopK: 12,
      maxConcurrency: 4,
      rrfK: 60,
      denseWeight: 1,
      sparseWeight: 0,
      maxPerDocument: 3,
      maxPerSection: 2,
      minimumResults: 3,
      maxRounds: 2,
    },
    planSha256: 'a'.repeat(64),
  };
}
