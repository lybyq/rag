/**
 * M04 Chunk Golden Snapshot。
 * 合成样本覆盖标题跨页、多级表头、条款、FAQ、代码和重复页；快照固定可检索字段而非内部对象布局。
 *
 * @requirement KNO-002
 * @requirement KNO-003
 * @requirement KNO-004
 * @requirement KNO-005
 * @requirement KNO-006
 * @requirement KNO-007
 * @requirement KNO-008
 * @requirement KNO-015
 */
import type { DocumentBlock, SupportedFileFormat } from '@rag/contracts';
import manifest from '../../../test/fixtures/m04/golden-manifest.json';
import { buildKnowledgeChunks } from './chunk-builder';
import { Cl100kTextTokenizer } from './tokenizer';
import type { KnowledgeChunkBuildResult } from './types';

const parseRunId = '11111111-1111-4111-8111-111111111111';
const documentVersionId = '22222222-2222-4222-8222-222222222222';
const tokenizer = new Cl100kTextTokenizer();

function block(
  ordinal: number,
  type: DocumentBlock['type'],
  text: string,
  overrides: Partial<DocumentBlock> = {},
): DocumentBlock {
  return {
    id: `golden-block-${ordinal}`,
    parseRunId,
    documentVersionId,
    contentRevision: 1,
    ordinal,
    type,
    text,
    originalText: text,
    pageNo: 1,
    sheetName: null,
    slideNo: null,
    bbox: null,
    headingLevel: null,
    parentBlockId: null,
    confidence: null,
    table: null,
    parserName: 'golden-parser',
    parserRevision: '1',
    ocrEngine: null,
    ocrRevision: null,
    metadata: {},
    contentSha256: 'a'.repeat(64),
    createdAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

const cases: Readonly<
  Record<string, { format: SupportedFileFormat; blocks: readonly DocumentBlock[] }>
> = {
  'prose-heading-cross-page': {
    format: 'PDF',
    blocks: [
      block(1, 'TITLE', '员工差旅制度', { headingLevel: 1 }),
      block(2, 'TITLE', '住宿标准', { headingLevel: 2 }),
      block(3, 'PARAGRAPH', '一线城市住宿标准为每晚六百元。', { pageNo: 1 }),
      block(4, 'PARAGRAPH', '其他城市住宿标准为每晚四百元。', { pageNo: 2 }),
      block(5, 'FOOTNOTE', '注：金额均为含税价。', { pageNo: 2 }),
    ],
  },
  'xlsx-multi-header': {
    format: 'XLSX',
    blocks: [
      block(1, 'TABLE', '年度预算', {
        pageNo: null,
        sheetName: '预算汇总',
        table: {
          rows: [
            ['部门', '2026 预算', '2026 预算'],
            ['部门', '上半年', '下半年'],
            ['研发', '100', '120'],
            ['市场', '80', '90'],
          ],
          headerRowCount: 2,
          mergedCells: [{ row: 0, column: 1, rowSpan: 1, columnSpan: 2 }],
        },
      }),
    ],
  },
  'contract-clauses': {
    format: 'DOCX',
    blocks: [
      block(1, 'TITLE', '服务合同', { headingLevel: 1 }),
      block(2, 'PARAGRAPH', '第一条 服务范围：乙方提供知识库实施服务。'),
      block(3, 'PARAGRAPH', '第二条 付款条件：验收通过后三十日付款。'),
      block(4, 'PARAGRAPH', '第三条 保密义务：双方不得披露资料。'),
    ],
  },
  'faq-pairs': {
    format: 'HTML',
    blocks: [
      block(1, 'TITLE', '报销 FAQ', { headingLevel: 1 }),
      block(2, 'PARAGRAPH', 'Q：发票遗失怎么办？'),
      block(3, 'PARAGRAPH', 'A：提交遗失说明并由部门负责人审批。'),
      block(4, 'PARAGRAPH', 'Q：多久内需要提交？'),
      block(5, 'PARAGRAPH', 'A：费用发生后三十日内。'),
    ],
  },
  'code-and-duplicate-page': {
    format: 'MARKDOWN',
    blocks: [
      block(1, 'TITLE', '部署说明', { headingLevel: 1 }),
      block(2, 'CODE', 'export const enabled = true;\n'.repeat(16), { pageNo: 1 }),
      block(3, 'PARAGRAPH', '本页为统一免责声明，禁止对外传播。', { pageNo: 1 }),
      block(4, 'PARAGRAPH', '本页为统一免责声明，禁止对外传播。', { pageNo: 2 }),
    ],
  },
};

describe('[KNO-015] M04 Chunk Golden Snapshot', () => {
  it('Manifest 覆盖五类高风险结构且只使用合成公开数据', () => {
    expect(manifest.license).toBe('synthetic-public-test-data');
    expect(manifest.cases.map((item) => item.id)).toEqual(Object.keys(cases));
  });

  for (const goldenCase of manifest.cases) {
    it(`${goldenCase.id} 输出稳定 Chunk 字段和关系`, () => {
      const fixture = cases[goldenCase.id];
      if (!fixture) throw new Error(`缺少 Golden Fixture：${goldenCase.id}`);
      const result = buildGoldenCase(fixture);
      const ordinalById = new Map(result.chunks.map((chunk) => [chunk.id, chunk.ordinal]));
      const snapshot = {
        chunks: result.chunks.map((chunk) => ({
          ordinal: chunk.ordinal,
          granularity: chunk.granularity,
          contentType: chunk.contentType,
          displayContent: chunk.displayContent,
          embeddingText: chunk.embeddingText,
          tokenCount: chunk.tokenCount,
          headingPath: chunk.headingPath,
          sourceBlockIds: chunk.sourceLocations.map((location) => location.blockId),
          parentOrdinal: chunk.parentChunkId ? ordinalById.get(chunk.parentChunkId) : null,
          dedupStatus: chunk.dedupStatus,
          duplicateOfOrdinal: chunk.duplicateOfChunkId
            ? ordinalById.get(chunk.duplicateOfChunkId)
            : null,
          splitReason: chunk.splitReason,
        })),
        relations: result.relations.map((relation) => ({
          fromOrdinal: ordinalById.get(relation.fromChunkId),
          type: relation.relationType,
          toOrdinal: relation.toChunkId ? ordinalById.get(relation.toChunkId) : null,
          toBlockId: relation.toBlockId,
        })),
      };

      expect(snapshot).toMatchSnapshot();
      expect(
        result.chunks
          .filter((chunk) => chunk.granularity === 'CHILD')
          .every((chunk) => chunk.sourceLocations.length > 0 && chunk.tokenCount <= 64),
      ).toBe(true);
    });
  }

  it('关键字段抽取准确率为 100%，并覆盖结构、来源与去重关系', () => {
    const prose = buildGoldenCase(cases['prose-heading-cross-page']);
    const table = buildGoldenCase(cases['xlsx-multi-header']);
    const clauses = buildGoldenCase(cases['contract-clauses']);
    const faq = buildGoldenCase(cases['faq-pairs']);
    const duplicate = buildGoldenCase(cases['code-and-duplicate-page']);
    const proseChild = prose.chunks.find(
      (chunk) => chunk.granularity === 'CHILD' && chunk.contentType === 'PROSE',
    );
    const tableChild = table.chunks.find(
      (chunk) => chunk.granularity === 'CHILD' && chunk.contentType === 'TABLE',
    );

    // 每一项都是一个可解释字段事实；新增 Golden 风险类型时，应同步扩充评测项而不是降低阈值。
    const fieldChecks = [
      proseChild?.headingPath.join(' > ') === '员工差旅制度 > 住宿标准',
      proseChild?.sourceLocations.map((item) => item.pageNo).join(',') === '1,2',
      prose.relations.some((relation) => relation.relationType === 'FOOTNOTE'),
      tableChild?.displayContent.includes('| 部门 | 2026 预算 | 2026 预算 |') === true,
      tableChild?.displayContent.includes('| 部门 | 上半年 | 下半年 |') === true,
      tableChild?.sourceLocations[0]?.sheetName === '预算汇总',
      clauses.chunks.filter(
        (chunk) => chunk.granularity === 'CHILD' && chunk.contentType === 'CLAUSE',
      ).length === 3,
      faq.chunks.filter((chunk) => chunk.granularity === 'CHILD' && chunk.contentType === 'FAQ')
        .length === 2,
      duplicate.chunks.some((chunk) => chunk.dedupStatus === 'SUPPRESSED_DUPLICATE'),
      duplicate.relations.some((relation) => relation.relationType === 'DUPLICATE_OF'),
    ];
    const accuracy = fieldChecks.filter(Boolean).length / fieldChecks.length;

    expect(fieldChecks).toEqual(Array.from({ length: fieldChecks.length }, () => true));
    expect(accuracy).toBe(1);
  });
});

function buildGoldenCase(
  fixture: { format: SupportedFileFormat; blocks: readonly DocumentBlock[] } | undefined,
): KnowledgeChunkBuildResult {
  if (!fixture) throw new Error('缺少 Golden Fixture');
  return buildKnowledgeChunks(
    {
      documentVersionId,
      contentRevision: 1,
      fileFormat: fixture.format,
      blocks: fixture.blocks,
    },
    tokenizer,
    { childMaxTokens: 64, parentMaxTokens: 140, overlapTokens: 8, dedupMode: 'SUPPRESS' },
  );
}
