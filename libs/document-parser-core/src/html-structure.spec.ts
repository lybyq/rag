/**
 * HTML/Markdown 共用结构抽取回归。
 * 样本只使用公开合成文本，固定阅读顺序、文本归属、列表层级和表格坐标语义。
 *
 * @requirement PAR-018
 */
import { createDocumentParserRegistry } from './index';
import type { ParserResult } from '@rag/contracts';
import type { DocumentParserInput, DocumentParserLimits } from './types';

const limits: DocumentParserLimits = {
  maxArchiveDepth: 3,
  maxCompressionRatio: 100,
  maxPages: 100,
  maxTotalPixels: 10_000_000,
  maxTableCells: 100_000,
  maxExpandedTableCells: 200_000,
  maxTableRows: 10_000,
  maxTableColumns: 1_000,
  maxTableSpan: 1_000,
  maxOutputCharacters: 1_000_000,
  maxInputBytes: 2_000_000,
  maxArchiveEntries: 1_000,
  maxXmlEntryBytes: 2_000_000,
};
const registry = createDocumentParserRegistry(limits, {
  revision: 'html-structure-r1',
  protocolVersion: '2',
});

describe('[PAR-018] HTML/Markdown DOM reading order', () => {
  it('保留容器直接文本、裸文本和 br 换行，并且父容器不重复子 Block', async () => {
    const result = await parse(
      'HTML',
      '<div>开头 <span>强调</span><br>下一行<section>子正文</section>结尾</div>',
    );

    expect(result.blocks.map((block) => block.originalText)).toEqual([
      '开头 强调\n下一行',
      '子正文',
      '结尾',
    ]);
    expect(result.blocks.map((block) => block.type)).toEqual([
      'PARAGRAPH',
      'PARAGRAPH',
      'PARAGRAPH',
    ]);
  });

  it('嵌套列表只输出各自拥有的文本，并保留层级、类型和编号', async () => {
    const result = await parse(
      'HTML',
      '<ol start="3"><li>父一<ul><li>子项</li></ul></li><li value="8">父二</li></ol>',
    );

    expect(result.blocks.map((block) => block.originalText)).toEqual(['父一', '子项', '父二']);
    expect(result.blocks.map((block) => block.metadata)).toEqual([
      expect.objectContaining({ listDepth: 1, listKind: 'ORDERED', itemNumber: 3 }),
      expect.objectContaining({ listDepth: 2, listKind: 'UNORDERED', itemNumber: null }),
      expect.objectContaining({ listDepth: 1, listKind: 'ORDERED', itemNumber: 8 }),
    ]);
  });

  it('引用保留语义、普通文本规范化空白，而 pre 代码完整保留空格和换行', async () => {
    const result = await parse(
      'HTML',
      '<blockquote> 裸  引文 <p>段<br>落</p></blockquote><pre>  const x = 1;\n    x += 1;</pre>',
    );

    expect(result.blocks).toEqual([
      expect.objectContaining({
        type: 'PARAGRAPH',
        originalText: '裸 引文',
        metadata: expect.objectContaining({ semantic: 'BLOCKQUOTE', quoteDepth: 1 }),
      }),
      expect.objectContaining({
        type: 'PARAGRAPH',
        originalText: '段\n落',
        metadata: expect.objectContaining({ semantic: 'BLOCKQUOTE', quoteDepth: 1 }),
      }),
      expect.objectContaining({ type: 'CODE', originalText: '  const x = 1;\n    x += 1;' }),
    ]);
  });

  it('rowspan/colspan 会补齐末尾矩阵，所有合并范围都落在 rows 内', async () => {
    const result = await parse(
      'HTML',
      '<table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td colspan="2">X</td><td rowspan="2">Y</td></tr></table>',
    );
    const table = result.blocks[0]?.table;

    expect(table?.rows).toEqual([
      ['A', 'B', 'C'],
      ['X', '', 'Y'],
      ['', '', ''],
    ]);
    expect(table?.mergedCells).toEqual([
      { row: 1, column: 0, rowSpan: 1, columnSpan: 2 },
      { row: 1, column: 2, rowSpan: 2, columnSpan: 1 },
    ]);
    for (const merged of table?.mergedCells ?? []) {
      expect(merged.row + merged.rowSpan).toBeLessThanOrEqual(table?.rows.length ?? 0);
      expect(merged.column + merged.columnSpan).toBeLessThanOrEqual(table?.rows[0]?.length ?? 0);
    }
  });

  it('嵌套表格从外层单元格正文分离，内层行不会混入外层矩阵', async () => {
    const result = await parse(
      'HTML',
      '<table><tr><td>外层<table><tr><td>内层</td></tr></table></td><td>右侧</td></tr></table>',
    );
    const tables = result.blocks.filter((block) => block.type === 'TABLE');

    expect(tables).toHaveLength(2);
    expect(tables[0]?.table?.rows).toEqual([['外层', '右侧']]);
    expect(tables[1]?.table?.rows).toEqual([['内层']]);
    expect(result.warnings).toContain('HTML_NESTED_TABLE_SEPARATED');
  });

  it('Markdown 标题、硬换行、嵌套列表、代码与图片说明保持顺序和语义', async () => {
    const markdown = [
      '# 标题',
      '',
      '第一行  ',
      '第二行',
      '',
      '1. 父项',
      '   - 子项',
      '',
      '```ts',
      '  const answer = 42;',
      '```',
      '',
      '![架构图](https://example.invalid/diagram.png)',
    ].join('\n');
    const result = await parse('MARKDOWN', markdown);

    expect(result.blocks.map((block) => [block.type, block.originalText])).toEqual([
      ['TITLE', '标题'],
      ['PARAGRAPH', '第一行\n第二行'],
      ['LIST', '父项'],
      ['LIST', '子项'],
      ['CODE', '  const answer = 42;\n'],
      ['IMAGE', '架构图'],
    ]);
    expect(result.blocks[3]?.metadata).toEqual(
      expect.objectContaining({ listDepth: 2, listKind: 'UNORDERED' }),
    );
    expect(result.ocrCandidates).toEqual([]);
  });
});

/** 使用真实 Registry，确保抽取结果还会经过统一预算与 ParserResult Zod。 */
async function parse(format: 'HTML' | 'MARKDOWN', source: string): Promise<ParserResult> {
  const input: DocumentParserInput = {
    bytes: Buffer.from(source),
    fileName: format === 'HTML' ? 'structure.html' : 'structure.md',
    format,
    declaredMime: format === 'HTML' ? 'text/html' : 'text/markdown',
  };
  return registry.parse(input, new AbortController().signal);
}
