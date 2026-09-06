/**
 * PDF 版面事实回归：验证 TextItem 坐标、标题依据、分栏顺序、装饰元素、表格去重和 OCR 决策。
 * 测试 PDF 由最小对象/xref 生成器在内存构造，只使用标准 Type1 字体和公开合成内容。
 *
 * @requirement PAR-022
 */
import type { DocumentBlock, ParserResult } from '@rag/contracts';
import { buildDocumentBlocks } from '@rag/parser-core';
import { restoreDocumentStructure } from '@rag/chunking';
import { createDocumentParserRegistry } from './index';

const registry = createDocumentParserRegistry(
  {
    maxArchiveDepth: 3,
    maxCompressionRatio: 100,
    maxPages: 100,
    maxTotalPixels: 20_000_000,
    maxTableCells: 100_000,
    maxExpandedTableCells: 200_000,
    maxTableRows: 10_000,
    maxTableColumns: 1_000,
    maxTableSpan: 1_000,
    maxOutputCharacters: 1_000_000,
    maxInputBytes: 10_000_000,
    maxArchiveEntries: 10_000,
    maxXmlEntryBytes: 5_000_000,
  },
  { revision: 'pdf-structure-r1', protocolVersion: '2' },
);

describe('[PAR-022] PDF text item structure', () => {
  it('用字号/编号依据恢复标题，普通加粗短句不误判，并单独保留 PDF metadata Title', async () => {
    const result = await parsePdf(
      buildPdf([
        pageOne(),
        textCommands([
          text('Company Confidential', 50, 770, 9),
          text('2 Details', 50, 700, 22),
          text('Second chapter body.', 50, 660, 12),
          text('Page 2', 280, 20, 9),
        ]),
      ]),
    );

    expect(result.inspection.documentTitle).toBe('Metadata Only Title');
    expect(
      result.blocks.filter((block) => block.type === 'TITLE').map((block) => block.text),
    ).toEqual(['1 Overview', '2 Details']);
    expect(result.blocks.find((block) => block.text === 'Important')).toMatchObject({
      type: 'PARAGRAPH',
    });
    expect(result.blocks.find((block) => block.text === '1 Overview')?.metadata).toMatchObject({
      headingInference: {
        algorithmRevision: 'pdf-heading-v1',
        confidence: expect.any(Number),
        reasons: expect.arrayContaining(['FONT_SIZE_RATIO', 'SECTION_NUMBERING']),
      },
      bboxPrecision: 'PDF_TEXT_ITEM',
    });
    expect(result.blocks.filter((block) => block.type === 'HEADER')).toHaveLength(2);
    expect(result.blocks.filter((block) => block.type === 'FOOTER')).toHaveLength(2);
  });

  it('分栏页面按左栏从上到下，再读右栏，不按同一 y 坐标左右交替', async () => {
    const result = await parsePdf(buildPdf([pageOne()]));
    const columns = result.blocks
      .filter((block) => /^(Left|Right)/.test(block.text))
      .map((block) => block.text);
    expect(columns).toEqual(['Left one', 'Left two', 'Right one', 'Right two']);
  });

  it('标题路径进入 Chunking，正文继承对应章节而不只是在 Parser 中出现 TITLE', async () => {
    const result = await parsePdf(buildPdf([pageOne()]));
    const drafts = buildDocumentBlocks({
      parseRunId: '11111111-1111-4111-8111-111111111111',
      documentVersionId: '22222222-2222-4222-8222-222222222222',
      contentRevision: 1,
      parserName: result.parserName,
      parserRevision: result.parserRevision,
      candidates: result.blocks,
    });
    const blocks = drafts.map((draft) => ({
      ...draft,
      createdAt: '2026-09-06T00:00:00.000Z',
    })) as readonly DocumentBlock[];
    const structured = restoreDocumentStructure(blocks);

    expect(
      structured.find((item) => item.block.text === 'Body under overview.')?.headingPath,
    ).toEqual(['1 Overview']);
  });

  it('区分短标题页、扫描页和混合页：空白页不 OCR，含图无字页和低字混合页才生成目标', async () => {
    const result = await parsePdf(
      buildPdf([
        textCommands([text('Short title', 50, 700, 22)]),
        inlineImageCommands([]),
        inlineImageCommands([text('Mixed label', 50, 700, 12)]),
        '',
      ]),
    );

    expect(result.pages.map((page) => page.imageOnly)).toEqual([false, true, false, false]);
    expect(result.ocrCandidates.map((target) => [target.pageNo, target.reason])).toEqual([
      [2, 'NO_NATIVE_TEXT'],
      [3, 'LOW_TEXT_COVERAGE'],
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining(['PDF_BLANK_PAGE_FOUND', 'PDF_MIXED_PAGE_REQUIRES_OCR']),
    );
    expect(result.blocks.find((block) => block.text === 'Short title')?.type).toBe('PARAGRAPH');
  }, 20_000);

  it('跨页连续正文保留双向锚点，不与重复页眉页脚混在一起', async () => {
    const result = await parsePdf(
      buildPdf([
        textCommands([text('Cross page paragraph', 50, 35, 12)]),
        textCommands([text('continues on next page.', 50, 750, 12)]),
      ]),
    );
    expect(
      result.blocks.find((block) => block.text === 'Cross page paragraph')?.metadata,
    ).toMatchObject({
      continuesOnNextPage: true,
      continuationAlgorithmRevision: 'pdf-cross-page-v1',
    });
    expect(
      result.blocks.find((block) => block.text === 'continues on next page.')?.metadata,
    ).toMatchObject({
      continuesFromPreviousPage: true,
      continuationAlgorithmRevision: 'pdf-cross-page-v1',
    });
  });

  it('旋转页坐标经 viewport 统一后仍在 0～1，并明确记录旋转与真实 TextItem 精度', async () => {
    const result = await parsePdf(
      buildPdf([textCommands([text('Rotated text', 50, 700, 12)])], [90]),
    );
    const block = result.blocks.find((item) => item.text === 'Rotated text');
    expect(block?.bbox).not.toBeNull();
    for (const coordinate of Object.values(block?.bbox ?? {})) {
      expect(coordinate).toBeGreaterThanOrEqual(0);
      expect(coordinate).toBeLessThanOrEqual(1);
    }
    expect(block?.metadata).toMatchObject({ pageRotation: 90, bboxPrecision: 'PDF_TEXT_ITEM' });
  });

  it('矢量表格正文只输出一次 TABLE，不再同时保留重复单元格段落', async () => {
    const result = await parsePdf(buildPdf([tablePage()]));
    const table = result.blocks.find((block) => block.type === 'TABLE');
    expect(table?.table?.rows).toEqual([
      ['Name', 'Value'],
      ['Alpha', '10'],
    ]);
    const prose = result.blocks
      .filter((block) => block.type !== 'TABLE')
      .map((block) => block.text)
      .join(' ');
    expect(prose).not.toMatch(/Name|Value|Alpha|10/);
  });

  it('通过 PDF 对象模型检查附件和打开动作，不把原始字节搜索冒充完整检查', async () => {
    const result = await parsePdf(
      buildPdf([textCommands([text('Attachment policy', 50, 700, 12)])], [], true),
    );
    expect(result.inspection).toMatchObject({
      embeddedObjectCount: 1,
      embeddedObjectInspectionComplete: true,
      activeActionCount: expect.any(Number),
    });
    expect(result.inspection.activeActionCount).toBeGreaterThan(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining(['PDF_EMBEDDED_FILE_FOUND', 'PDF_ACTIVE_ACTION_FOUND']),
    );
  });
});

/** Registry 入口保证 ParserResult 仍通过统一 Zod 契约。 */
async function parsePdf(bytes: Uint8Array): Promise<ParserResult> {
  return registry.parse(
    {
      bytes,
      fileName: 'layout.pdf',
      format: 'PDF',
      declaredMime: 'application/pdf',
    },
    new AbortController().signal,
  );
}

/** 第一页同时包含标题反例、正文和左右两栏。 */
function pageOne(): string {
  return textCommands([
    text('Company Confidential', 50, 770, 9),
    text('1 Overview', 50, 700, 24),
    text('Body under overview.', 50, 660, 12),
    text('Important', 50, 625, 12, 'F2'),
    text('Left one', 50, 500, 12),
    text('Left two', 50, 470, 12),
    text('Right one', 350, 500, 12),
    text('Right two', 350, 470, 12),
    text('Page 1', 280, 20, 9),
  ]);
}

/** 两行两列表格，矩形和中线供 pdf.js 矢量表格检测器使用。 */
function tablePage(): string {
  return `${textCommands([
    text('Name', 65, 555, 12),
    text('Value', 165, 555, 12),
    text('Alpha', 65, 515, 12),
    text('10', 165, 515, 12),
  ])}\n0.5 w 50 500 200 80 re S 150 500 m 150 580 l S 50 540 m 250 540 l S`;
}

/** 创建一个文字操作。 */
function text(value: string, x: number, y: number, size: number, font: 'F1' | 'F2' = 'F1'): string {
  return `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapePdfText(value)}) Tj ET`;
}

/** 多个 PDF 操作按换行组合，便于调试原始流。 */
function textCommands(commands: readonly string[]): string {
  return commands.join('\n');
}

/** 1×1 灰度 XObject；可与少量原生文字共同构成混合页。 */
function inlineImageCommands(commands: readonly string[]): string {
  return `${commands.join('\n')}\nq 200 0 0 200 200 250 cm /Im1 Do Q`;
}

/** 转义 PDF literal string 的三个结构字符。 */
function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

/**
 * 构造多页 PDF 1.7：页面、内容流、标准字体和 Info Title 都有真实对象与 xref。
 * rotate 数组与页面一一对应，缺省为 0。
 */
function buildPdf(
  pageStreams: readonly string[],
  rotate: readonly number[] = [],
  includeAttachment = false,
): Uint8Array {
  const objects: string[] = [];
  const add = (value: string): number => {
    objects.push(value);
    return objects.length;
  };
  const catalogId = add('');
  const pagesId = add('');
  const regularFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const boldFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const imageId = add(
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream',
  );
  const pageIds: number[] = [];

  pageStreams.forEach((stream, index) => {
    const contentId = add(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
    const rotation = rotate[index] ? ` /Rotate ${rotate[index]}` : '';
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 600 800]${rotation} /Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  });
  const infoId = add('<< /Title (Metadata Only Title) >>');
  let catalogExtras = '';
  if (includeAttachment) {
    const embeddedFileId = add('<< /Type /EmbeddedFile /Length 8 >>\nstream\nevidence\nendstream');
    const fileSpecId = add(
      `<< /Type /Filespec /F (evidence.txt) /UF (evidence.txt) /EF << /F ${embeddedFileId} 0 R >> >>`,
    );
    const actionId = add('<< /S /JavaScript /JS (app.alert\\(review\\)) >>');
    catalogExtras = ` /Names << /EmbeddedFiles << /Names [(evidence.txt) ${fileSpecId} 0 R] >> >> /OpenAction ${actionId} 0 R`;
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${catalogExtras} >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let source = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source, 'latin1'));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(source, 'latin1');
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(source, 'latin1');
}
