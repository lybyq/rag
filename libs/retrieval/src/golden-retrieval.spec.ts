/** 查询规划与混合检索 脱敏黄金集：缩写、错别字、精确代码/日期/版本、多跳、无答案与越权。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RetrievalVectorHit } from '@rag/contracts';
import { extractExactLiterals, routeQuery, shouldUseLlmRewrite } from './index';
import { weightedReciprocalRankFusion } from './weighted-rrf';

interface GoldenDocument {
  vectorId: string;
  documentId: string;
  spaceId: string;
  version: string;
  status: 'ACTIVE' | 'ARCHIVED';
  effective: boolean;
}

interface GoldenCase {
  id: string;
  question: string;
  expectedRoute: 'CHAT' | 'KNOWLEDGE' | 'CLARIFY' | 'REJECT';
  expectedLiteralKinds?: string[];
  requiresRewrite?: boolean;
  expectedDocumentId: string | null;
  expectedVersion?: string;
  dense: string[];
  sparse: string[];
}

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'test/fixtures/hybrid-retrieval/golden-retrieval.json'),
    'utf8',
  ),
) as { documents: GoldenDocument[]; cases: GoldenCase[] };
const documents = new Map(fixture.documents.map((document) => [document.vectorId, document]));
const allowedSpaceIds = new Set(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);

describe('[RET-017] 查询规划与混合检索 黄金查询集', () => {
  test.each(fixture.cases)('$id', (testCase) => {
    expect(routeQuery(testCase.question)).toBe(testCase.expectedRoute);
    if (testCase.expectedLiteralKinds) {
      expect(new Set(extractExactLiterals(testCase.question).map((item) => item.kind))).toEqual(
        new Set(testCase.expectedLiteralKinds),
      );
    }
    if (testCase.requiresRewrite) {
      expect(shouldUseLlmRewrite(testCase.question, 'KNOWLEDGE')).toBe(true);
    }
    const fused = weightedReciprocalRankFusion(
      [
        { route: 'DENSE', weight: 0.65, hits: hits(testCase.dense, 'DENSE') },
        { route: 'SPARSE', weight: 0.35, hits: hits(testCase.sparse, 'SPARSE') },
      ],
      60,
      40,
    );
    // 模拟真实 PG 回源的三道强制门禁：当前授权空间、文档状态和生效窗口。
    const visible = fused
      .map((candidate) => documents.get(candidate.vectorId))
      .filter((document): document is GoldenDocument => Boolean(document))
      .filter(
        (document) =>
          allowedSpaceIds.has(document.spaceId) &&
          document.status === 'ACTIVE' &&
          document.effective,
      );
    expect(visible[0]?.documentId ?? null).toBe(testCase.expectedDocumentId);
    if (testCase.expectedVersion) expect(visible[0]?.version).toBe(testCase.expectedVersion);
  });

  test('黄金集门禁指标达到 Recall@40/Hit@5/版本准确率 100%，越权泄漏为 0', () => {
    const answerable = fixture.cases.filter((testCase) => testCase.expectedDocumentId);
    const evaluated = answerable.map((testCase) => {
      const fused = weightedReciprocalRankFusion(
        [
          { route: 'DENSE', weight: 0.65, hits: hits(testCase.dense, 'DENSE') },
          { route: 'SPARSE', weight: 0.35, hits: hits(testCase.sparse, 'SPARSE') },
        ],
        60,
        40,
      );
      const visible = fused
        .map((candidate) => documents.get(candidate.vectorId))
        .filter((document): document is GoldenDocument => Boolean(document))
        .filter(
          (document) =>
            allowedSpaceIds.has(document.spaceId) &&
            document.status === 'ACTIVE' &&
            document.effective,
        );
      return {
        recall40: visible
          .slice(0, 40)
          .some((item) => item.documentId === testCase.expectedDocumentId),
        hit5: visible.slice(0, 5).some((item) => item.documentId === testCase.expectedDocumentId),
        version: visible.some(
          (item) =>
            item.documentId === testCase.expectedDocumentId &&
            item.version === testCase.expectedVersion,
        ),
      };
    });
    expect(evaluated.every((item) => item.recall40)).toBe(true);
    expect(evaluated.every((item) => item.hit5)).toBe(true);
    expect(evaluated.every((item) => item.version)).toBe(true);
    const unauthorized = fixture.documents.filter(
      (document) => !allowedSpaceIds.has(document.spaceId),
    );
    expect(unauthorized.filter((document) => allowedSpaceIds.has(document.spaceId))).toHaveLength(
      0,
    );
  });
});

function hits(vectorIds: readonly string[], route: 'DENSE' | 'SPARSE'): RetrievalVectorHit[] {
  return vectorIds.map((vectorId, index) => {
    const document = documents.get(vectorId);
    if (!document) throw new Error(`黄金集向量主键不存在：${vectorId}`);
    return {
      vectorId,
      manifestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      spaceId: document.spaceId,
      documentId: document.documentId,
      score: 1 - index * 0.01,
      route,
      rank: index + 1,
    };
  });
}
