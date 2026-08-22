/**
 * HTML/Markdown 共用的安全结构抽取器。
 * Cheerio 只构建服务端 DOM，不执行脚本；本文件删除活动内容，并把标题、段落、列表、代码、
 * 表格、图片和说明映射为统一 Block。它不抓取外链资源。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-009
 * @requirement PAR-011
 */
import { load, type CheerioAPI } from 'cheerio';
import type { DocumentTable, OcrTarget, ParsedBlockCandidate } from '@rag/contracts';
import { createBlock } from './types';

/** HTML 结构抽取结果供 HTML Parser 与 Markdown Parser 复用。 */
export interface HtmlStructureResult {
  readonly blocks: readonly ParsedBlockCandidate[];
  readonly ocrCandidates: readonly OcrTarget[];
  readonly externalLinkCount: number;
  readonly embeddedObjectCount: number;
  readonly tableCellCount: number;
  readonly warnings: readonly string[];
}

/** 把已解码 HTML 映射为稳定文档顺序，所有远程链接只计数而不访问。 */
export function parseHtmlStructure(html: string): HtmlStructureResult {
  const $ = load(html);
  const embeddedObjectCount = $('object,embed,iframe').length;
  const externalLinkCount = countExternalLinks($);
  $('script,style,noscript,template,object,embed,iframe').remove();

  const blocks: ParsedBlockCandidate[] = [];
  const ocrCandidates: OcrTarget[] = [];
  let tableCellCount = 0;
  $('h1,h2,h3,h4,h5,h6,p,li,pre,table,img,figcaption').each((index, element) => {
    const tagName = element.tagName.toLowerCase();
    const node = $(element);
    // table 内部的 p/li/pre 由表格整体负责；figure 中的 figcaption 独立保留。
    if (tagName !== 'table' && node.parents('table').length > 0) return;
    if (tagName === 'p' && node.parents('li').length > 0) return;

    if (tagName === 'table') {
      const table = readHtmlTable($, element);
      if (!table) return;
      tableCellCount += table.rows.reduce((sum, row) => sum + row.length, 0);
      const originalText = table.rows.map((row) => row.join(' | ')).join('\n');
      blocks.push(
        createBlock('TABLE', originalText, {
          table,
          metadata: { extractionSource: 'NATIVE', htmlIndex: index },
        }),
      );
      return;
    }
    if (tagName === 'img') {
      const alternative = node.attr('alt')?.trim() ?? '';
      const source = node.attr('src')?.trim() ?? '';
      blocks.push(
        createBlock('IMAGE', alternative, {
          metadata: {
            extractionSource: 'NATIVE',
            htmlIndex: index,
            sourceKind: classifyLink(source),
          },
        }),
      );
      ocrCandidates.push({
        targetId: `html-image-${index + 1}`,
        kind: 'EMBEDDED_IMAGE',
        pageNo: null,
        slideNo: null,
        sheetName: null,
        bbox: null,
        assetRef: null,
        reason: 'EMBEDDED_SCREENSHOT',
      });
      return;
    }

    const originalText = node.text();
    if (originalText.trim().length === 0) return;
    if (/^h[1-6]$/.test(tagName)) {
      blocks.push(
        createBlock('TITLE', originalText, {
          headingLevel: Number(tagName.slice(1)),
          metadata: { extractionSource: 'NATIVE', htmlIndex: index },
        }),
      );
      return;
    }
    const type =
      tagName === 'li'
        ? 'LIST'
        : tagName === 'pre'
          ? 'CODE'
          : tagName === 'figcaption'
            ? 'CAPTION'
            : 'PARAGRAPH';
    blocks.push(
      createBlock(type, originalText, {
        metadata: { extractionSource: 'NATIVE', htmlIndex: index },
      }),
    );
  });

  return {
    blocks,
    ocrCandidates,
    externalLinkCount,
    embeddedObjectCount,
    tableCellCount,
    warnings: embeddedObjectCount > 0 ? ['HTML_ACTIVE_EMBED_REMOVED'] : [],
  };
}

/** 解析 rowspan/colspan 并产生零起始合并单元格坐标。 */
function readHtmlTable(
  $: CheerioAPI,
  tableElement: Parameters<CheerioAPI>[0],
): DocumentTable | null {
  const rows: string[][] = [];
  const mergedCells: { row: number; column: number; rowSpan: number; columnSpan: number }[] = [];
  const occupied = new Set<string>();
  let headerRowCount = 0;

  $(tableElement)
    .find('tr')
    .each((rowIndex, rowElement) => {
      const row: string[] = [];
      let column = 0;
      const cells = $(rowElement).children('th,td');
      if (cells.length === 0) return;
      if (cells.filter('th').length === cells.length) headerRowCount += 1;
      cells.each((_cellIndex, cellElement) => {
        while (occupied.has(`${rowIndex}:${column}`)) column += 1;
        const cell = $(cellElement);
        const rowSpan = positiveSpan(cell.attr('rowspan'));
        const columnSpan = positiveSpan(cell.attr('colspan'));
        while (row.length < column) row.push('');
        row[column] = cell.text();
        for (let rowOffset = 0; rowOffset < rowSpan; rowOffset += 1) {
          for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
            if (rowOffset > 0 || columnOffset > 0) {
              occupied.add(`${rowIndex + rowOffset}:${column + columnOffset}`);
            }
          }
        }
        if (rowSpan > 1 || columnSpan > 1) {
          mergedCells.push({ row: rowIndex, column, rowSpan, columnSpan });
        }
        column += columnSpan;
      });
      rows.push(row);
    });

  const width = Math.max(0, ...rows.map((row) => row.length));
  for (const row of rows) while (row.length < width) row.push('');
  return rows.length > 0 ? { rows, headerRowCount, mergedCells } : null;
}

/** 非法跨度按 1 处理，避免恶意 HTML 制造超大稀疏数组。 */
function positiveSpan(value: string | undefined): number {
  const parsed = Number(value ?? 1);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10_000 ? parsed : 1;
}

/** 只判断 URL 类型，不发起 DNS 或网络请求。 */
function classifyLink(value: string): 'EMPTY' | 'DATA' | 'LOCAL' | 'EXTERNAL' {
  if (!value) return 'EMPTY';
  if (value.startsWith('data:')) return 'DATA';
  if (/^(https?:)?\/\//i.test(value)) return 'EXTERNAL';
  return 'LOCAL';
}

/** 统计会离开当前文档的链接，javascript/data 不执行但仍纳入外链审计。 */
function countExternalLinks($: CheerioAPI): number {
  let count = 0;
  $('a[href],img[src],link[href],video[src],audio[src],source[src]').each((_index, element) => {
    const node = $(element);
    const value = (node.attr('href') ?? node.attr('src') ?? '').trim();
    if (classifyLink(value) === 'EXTERNAL' || /^javascript:/i.test(value)) count += 1;
  });
  return count;
}
