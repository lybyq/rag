/**
 * M04 结构恢复、专用 Chunk、去重和质量 Policy 的核心规则测试。
 * 这些测试使用公开合成内容，先固定业务不变量，再允许实现选择具体算法。
 *
 * @requirement KNO-002
 * @requirement KNO-003
 * @requirement KNO-004
 * @requirement KNO-005
 * @requirement KNO-006
 * @requirement KNO-007
 * @requirement KNO-008
 * @requirement KNO-009
 * @requirement KNO-010
 */
import type { DocumentBlock } from '@rag/contracts';
import {
  buildKnowledgeChunks,
  Cl100kTextTokenizer,
  evaluateDocumentQuality,
  restoreDocumentStructure,
} from './index';

const parseRunId = '11111111-1111-4111-8111-111111111111';
const documentVersionId = '22222222-2222-4222-8222-222222222222';

function block(
  ordinal: number,
  type: DocumentBlock['type'],
  text: string,
  overrides: Partial<DocumentBlock> = {},
): DocumentBlock {
  return {
    id: `block-${ordinal}`,
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
    bbox: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.2 },
    headingLevel: null,
    parentBlockId: null,
    confidence: null,
    table: null,
    parserName: 'fixture-parser',
    parserRevision: '1',
    ocrEngine: null,
    ocrRevision: null,
    metadata: {},
    contentSha256: 'a'.repeat(64),
    createdAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('[KNO-002][KNO-005] restoreDocumentStructure', () => {
  it('跨页段落继承标题路径，但新标题和代码形成独立边界', () => {
    const restored = restoreDocumentStructure([
      block(1, 'TITLE', '第一章 总则', { headingLevel: 1 }),
      block(2, 'PARAGRAPH', '第一页正文。', { pageNo: 1 }),
      block(3, 'PARAGRAPH', '第二页延续正文。', { pageNo: 2 }),
      block(4, 'TITLE', '第二章 配置', { headingLevel: 1, pageNo: 2 }),
      block(5, 'CODE', 'const enabled = true;', { pageNo: 2 }),
    ]);

    expect(restored[1]?.headingPath).toEqual(['第一章 总则']);
    expect(restored[2]?.headingPath).toEqual(['第一章 总则']);
    expect(restored[1]?.boundaryKey).toBe(restored[2]?.boundaryKey);
    expect(restored[4]?.headingPath).toEqual(['第二章 配置']);
    expect(restored[4]?.boundaryKey).not.toBe(restored[3]?.boundaryKey);
  });

  it('页眉页脚不进入正文，脚注保留为可关联结构', () => {
    const restored = restoreDocumentStructure([
      block(1, 'HEADER', '公司内部资料'),
      block(2, 'PARAGRAPH', '制度正文'),
      block(3, 'FOOTNOTE', '注：金额均为含税价'),
      block(4, 'FOOTER', '第 1 页'),
    ]);

    expect(restored.find((item) => item.block.id === 'block-1')?.includeInChunk).toBe(false);
    expect(restored.find((item) => item.block.id === 'block-3')?.kind).toBe('FOOTNOTE');
    expect(restored.find((item) => item.block.id === 'block-4')?.includeInChunk).toBe(false);
  });
});

describe('[KNO-003][KNO-004][KNO-006][KNO-007] buildKnowledgeChunks', () => {
  const tokenizer = new Cl100kTextTokenizer();

  it('生成 Parent-Child、来源和前后邻居关系，并区分展示文本和 embedding 文本', () => {
    const result = buildKnowledgeChunks(
      {
        documentVersionId,
        contentRevision: 1,
        fileFormat: 'DOCX',
        blocks: [
          block(1, 'TITLE', '费用制度', { headingLevel: 1 }),
          block(2, 'PARAGRAPH', '差旅住宿需要提供发票。'),
          block(3, 'PARAGRAPH', '报销申请需要在三十日内提交。'),
        ],
      },
      tokenizer,
      { childMaxTokens: 24, parentMaxTokens: 80, overlapTokens: 4, dedupMode: 'SUPPRESS' },
    );

    const children = result.chunks.filter((item) => item.granularity === 'CHILD');
    expect(children.length).toBeGreaterThanOrEqual(1);
    expect(children.every((item) => item.parentChunkId !== null)).toBe(true);
    expect(children[0]?.embeddingText).toContain('费用制度');
    expect(children[0]?.displayContent).not.toMatch(/^费用制度\n/);
    expect(result.relations.some((item) => item.relationType === 'PARENT_CHILD')).toBe(true);
    expect(result.relations.some((item) => item.relationType === 'SOURCE_BLOCK')).toBe(true);
    expect(children.every((item) => item.tokenCount <= 24)).toBe(true);
  });

  it('多级表头在每个表格 Child 中重复，表格不会与普通段落混切', () => {
    const table = block(2, 'TABLE', '部门预算表', {
      table: {
        rows: [
          ['部门', '预算', '预算'],
          ['部门', '上半年', '下半年'],
          ['研发', '100', '120'],
          ['市场', '80', '90'],
        ],
        headerRowCount: 2,
        mergedCells: [{ row: 0, column: 1, rowSpan: 1, columnSpan: 2 }],
      },
    });
    const result = buildKnowledgeChunks(
      {
        documentVersionId,
        contentRevision: 1,
        fileFormat: 'XLSX',
        blocks: [block(1, 'TITLE', '年度计划', { headingLevel: 1 }), table],
      },
      tokenizer,
      { childMaxTokens: 60, parentMaxTokens: 120, overlapTokens: 0, dedupMode: 'SUPPRESS' },
    );
    const tableChildren = result.chunks.filter(
      (item) => item.granularity === 'CHILD' && item.contentType === 'TABLE',
    );

    expect(tableChildren.length).toBeGreaterThanOrEqual(1);
    expect(tableChildren.every((item) => item.embeddingText.includes('上半年'))).toBe(true);
    expect(result.relations.some((item) => item.relationType === 'TABLE_HEADER')).toBe(true);
    expect(
      result.chunks.some(
        (item) => item.contentType === 'TABLE' && item.displayContent.includes('普通段落'),
      ),
    ).toBe(false);
  });

  it('超长代码按真实 BPE Token 上限拆分并记录原因', () => {
    const result = buildKnowledgeChunks(
      {
        documentVersionId,
        contentRevision: 1,
        fileFormat: 'MARKDOWN',
        blocks: [block(1, 'CODE', 'const value = "企业知识";\n'.repeat(40))],
      },
      tokenizer,
      { childMaxTokens: 30, parentMaxTokens: 60, overlapTokens: 4, dedupMode: 'SUPPRESS' },
    );
    const children = result.chunks.filter((item) => item.granularity === 'CHILD');

    expect(children.length).toBeGreaterThan(1);
    expect(children.every((item) => item.tokenCount <= 30)).toBe(true);
    expect(children.every((item) => item.splitReason === 'TOKEN_LIMIT')).toBe(true);
  });
});

describe('[KNO-008] reversible deduplication', () => {
  it('跨页重复内容保留 Chunk 和来源，但标记为禁止索引并关联原件', () => {
    const result = buildKnowledgeChunks(
      {
        documentVersionId,
        contentRevision: 1,
        fileFormat: 'PDF',
        blocks: [
          block(1, 'PARAGRAPH', '本页为统一免责声明，禁止对外传播。', { pageNo: 1 }),
          block(2, 'PARAGRAPH', '本页为统一免责声明，禁止对外传播。', { pageNo: 2 }),
        ],
      },
      new Cl100kTextTokenizer(),
      { childMaxTokens: 20, parentMaxTokens: 50, overlapTokens: 0, dedupMode: 'SUPPRESS' },
    );
    const children = result.chunks.filter((item) => item.granularity === 'CHILD');
    const duplicate = children.find((item) => item.dedupStatus === 'SUPPRESSED_DUPLICATE');

    expect(children).toHaveLength(2);
    expect(duplicate?.duplicateOfChunkId).toBeTruthy();
    expect(duplicate?.eligibleForIndex).toBe(false);
    expect(
      result.relations.some(
        (item) => item.fromChunkId === duplicate?.id && item.relationType === 'DUPLICATE_OF',
      ),
    ).toBe(true);
    expect(
      result.relations.some(
        (item) => item.fromChunkId === duplicate?.id && item.relationType === 'SOURCE_BLOCK',
      ),
    ).toBe(true);
  });
});

describe('[KNO-009][KNO-010] evaluateDocumentQuality', () => {
  const tokenizer = new Cl100kTextTokenizer();
  const config = {
    minimumNonEmptyBlockRatio: 0.6,
    rejectNonEmptyBlockRatio: 0.2,
    minimumOcrConfidence: 0.75,
    maximumGarbledRatio: 0.03,
    rejectGarbledRatio: 0.15,
    maximumDuplicateRatio: 0.4,
    requireHeadingAfterBlocks: 5,
  } as const;

  it('负责人和版本一致、结构完整的内容自动 PASS', () => {
    const blocks = [
      block(1, 'TITLE', '制度', { headingLevel: 1 }),
      block(2, 'PARAGRAPH', '这是完整且可读的制度正文。'),
    ];
    const chunks = buildKnowledgeChunks(
      { documentVersionId, contentRevision: 1, fileFormat: 'DOCX', blocks },
      tokenizer,
      { childMaxTokens: 60, parentMaxTokens: 120, overlapTokens: 4, dedupMode: 'SUPPRESS' },
    ).chunks;
    const report = evaluateDocumentQuality(
      { blocks, chunks, expectedPageCount: 1, hasResponsibleOwner: true, versionConsistent: true },
      config,
    );

    expect(report.verdict).toBe('PASS');
    expect(report.findings).toHaveLength(0);
  });

  it('缺页和低 OCR 置信度进入 MANUAL_REVIEW', () => {
    const blocks = [
      block(1, 'PARAGRAPH', '扫描页内容', {
        pageNo: 1,
        confidence: 0.5,
        ocrEngine: 'fixture-ocr',
        ocrRevision: '1',
      }),
    ];
    const chunks = buildKnowledgeChunks(
      { documentVersionId, contentRevision: 1, fileFormat: 'PDF', blocks },
      tokenizer,
      { childMaxTokens: 60, parentMaxTokens: 120, overlapTokens: 4, dedupMode: 'SUPPRESS' },
    ).chunks;
    const report = evaluateDocumentQuality(
      { blocks, chunks, expectedPageCount: 2, hasResponsibleOwner: true, versionConsistent: true },
      config,
    );

    expect(report.verdict).toBe('MANUAL_REVIEW');
    expect(report.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(['QUALITY_MISSING_PAGES', 'QUALITY_OCR_CONFIDENCE_LOW']),
    );
  });

  it('缺少负责人或 revision 冲突时硬拒绝，人工审核不能掩盖事实', () => {
    const blocks = [block(1, 'PARAGRAPH', '正文')];
    const report = evaluateDocumentQuality(
      {
        blocks,
        chunks: [],
        expectedPageCount: 1,
        hasResponsibleOwner: false,
        versionConsistent: false,
      },
      config,
    );

    expect(report.verdict).toBe('REJECT');
    expect(report.findings.map((item) => item.code)).toEqual(
      expect.arrayContaining(['QUALITY_OWNER_MISSING', 'QUALITY_VERSION_CONFLICT']),
    );
  });
});
