/**
 * PPTX Parser：直接读取安全检查后的 OOXML Slide、关系和媒体部件。
 * 它按幻灯片顺序恢复标题、文本框、表格、图片 bbox 与 slideNo，并把图片区域交给 OCR 策略。
 * 不渲染幻灯片、不运行宏、不加载外部主题/字体，也不把 LibreOffice 当主 Parser。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-007
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 */
import { load } from 'cheerio';
import { posix } from 'node:path';
import type {
  DocumentTable,
  NormalizedBoundingBox,
  OcrTarget,
  ParsedBlockCandidate,
} from '@rag/contracts';
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, clamp01, createBlock, throwIfAborted } from './types';
import { readSafeOfficeArchive } from './safe-ooxml';
import { readImageDimensions } from './image-dimensions';

/** PowerPoint OOXML Parser。 */
export class PptxDocumentParser implements DocumentFormatParser {
  public readonly format = 'PPTX' as const;

  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    signal: AbortSignal,
  ): Promise<FormatParseOutput> {
    const archive = await readSafeOfficeArchive(input.bytes, 'PPTX', limits, signal);
    const slideNames = archive.entryNames
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((left, right) => slideNumber(left) - slideNumber(right));
    if (slideNames.length === 0)
      throw new DocumentParserError('PPTX_SLIDES_MISSING', 'PPTX 不包含幻灯片');
    if (slideNames.length > limits.maxPages) {
      throw new DocumentParserError('PAGE_LIMIT_EXCEEDED', 'PPTX 幻灯片数量超过安全上限');
    }
    const slideSize = readSlideSize(archive.entries.get('ppt/presentation.xml'));
    const blocks: ParsedBlockCandidate[] = [];
    const pages = [];
    const ocrCandidates: OcrTarget[] = [];
    let tableCellCount = 0;

    for (const slideName of slideNames) {
      throwIfAborted(signal);
      const slideNo = slideNumber(slideName);
      const bytes = archive.entries.get(slideName);
      if (!bytes) throw new DocumentParserError('PPTX_SLIDE_XML_MISSING', 'PPTX 幻灯片 XML 缺失');
      const xml = new TextDecoder().decode(bytes);
      const $ = load(xml, { xmlMode: true });
      const relationships = readSlideRelationships(archive.entries, slideName);
      let slideCharacters = 0;
      let pictureCount = 0;

      $('p\\:sp,p\\:graphicFrame,p\\:pic').each((shapeIndex, element) => {
        const node = $(element);
        const tag = element.tagName.toLowerCase();
        const bbox = readShapeBox(node, slideSize);
        const tableNode = node.find('a\\:tbl').first();
        if (tableNode.length > 0) {
          const table = readPptTable($, tableNode);
          if (!table) return;
          const cells = table.rows.reduce((sum, row) => sum + row.length, 0);
          tableCellCount += cells;
          blocks.push(
            createBlock('TABLE', table.rows.map((row) => row.join(' | ')).join('\n'), {
              pageNo: slideNo,
              slideNo,
              bbox,
              table,
              metadata: { extractionSource: 'NATIVE', shapeIndex },
            }),
          );
          return;
        }
        if (tag.endsWith(':pic')) {
          pictureCount += 1;
          const relationshipId = node.find('a\\:blip').attr('r:embed') ?? null;
          const entryPath = relationshipId ? (relationships.get(relationshipId) ?? null) : null;
          const alternative =
            node.find('p\\:cNvPr').attr('descr') ?? node.find('p\\:cNvPr').attr('name') ?? '';
          blocks.push(
            createBlock('IMAGE', alternative, {
              pageNo: slideNo,
              slideNo,
              bbox,
              metadata: { extractionSource: 'NATIVE', shapeIndex, archiveEntryPath: entryPath },
            }),
          );
          ocrCandidates.push({
            targetId: `pptx-slide-${slideNo}-image-${pictureCount}`,
            kind: 'EMBEDDED_IMAGE',
            pageNo: slideNo,
            slideNo,
            sheetName: null,
            bbox,
            assetRef: entryPath
              ? {
                  storage: 'SOURCE_ARCHIVE_ENTRY',
                  archiveEntryPath: entryPath,
                  mediaType: mediaTypeFromName(entryPath),
                }
              : null,
            reason: 'EMBEDDED_SCREENSHOT',
          });
          return;
        }
        const originalText = node
          .find('a\\:t')
          .toArray()
          .map((textNode) => $(textNode).text())
          .join('\n');
        if (originalText.trim().length === 0) return;
        slideCharacters += originalText.length;
        const placeholderType = node.find('p\\:ph').attr('type')?.toLowerCase();
        const isTitle = placeholderType === 'title' || placeholderType === 'ctrtitle';
        blocks.push(
          createBlock(isTitle ? 'TITLE' : 'PARAGRAPH', originalText, {
            pageNo: slideNo,
            slideNo,
            bbox,
            headingLevel: isTitle ? 1 : null,
            metadata: {
              extractionSource: 'NATIVE',
              shapeIndex,
              placeholderType: placeholderType ?? null,
            },
          }),
        );
      });

      pages.push({
        pageNo: slideNo,
        textCharacterCount: slideCharacters,
        textCoverage: Math.min(1, slideCharacters / 2_000),
        imageOnly: slideCharacters === 0 && pictureCount > 0,
      });
    }
    if (tableCellCount > limits.maxTableCells) {
      throw new DocumentParserError('TABLE_CELL_LIMIT_EXCEEDED', 'PPTX 表格单元格数量超过安全上限');
    }
    const mediaEntries = archive.entryNames.filter((name) => name.startsWith('ppt/media/'));
    const totalPixels = sumMediaPixels(mediaEntries, archive.entries);
    if (totalPixels > limits.maxTotalPixels) {
      throw new DocumentParserError('PIXEL_LIMIT_EXCEEDED', 'PPTX 内嵌图片总像素超过安全上限');
    }
    return {
      blocks,
      pages,
      ocrCandidates,
      inspection: {
        encrypted: archive.encrypted,
        hasMacros: archive.hasMacros,
        embeddedObjectCount: archive.embeddedObjectCount,
        externalLinkCount: archive.externalLinkCount,
        archiveDepth: archive.archiveDepth,
        compressedSizeBytes: archive.compressedSizeBytes,
        uncompressedSizeBytes: archive.uncompressedSizeBytes,
        pageCount: slideNames.length,
        totalPixels,
        tableCellCount,
      },
      warnings: ocrCandidates.length > 0 ? ['PPTX_EMBEDDED_IMAGES_REQUIRE_OCR_POLICY'] : [],
    };
  }
}

/** 从 presentation.xml 读取 EMU 画布尺寸；缺失时使用标准 16:9 尺寸。 */
function readSlideSize(bytes: Uint8Array | undefined): { width: number; height: number } {
  if (!bytes) return { width: 12_192_000, height: 6_858_000 };
  const $ = load(new TextDecoder().decode(bytes), { xmlMode: true });
  const node = $('p\\:sldSz').first();
  const width = Number(node.attr('cx'));
  const height = Number(node.attr('cy'));
  return width > 0 && height > 0 ? { width, height } : { width: 12_192_000, height: 6_858_000 };
}

/** 读取 shape 的 a:xfrm 坐标并归一化；表格和图片均可复用。 */
function readShapeBox(
  node: ReturnType<ReturnType<typeof load>>,
  slideSize: { width: number; height: number },
): NormalizedBoundingBox | null {
  const transform = node.find('a\\:xfrm').first();
  const offset = transform.find('a\\:off').first();
  const extent = transform.find('a\\:ext').first();
  const x = Number(offset.attr('x'));
  const y = Number(offset.attr('y'));
  const width = Number(extent.attr('cx'));
  const height = Number(extent.attr('cy'));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x1: clamp01(x / slideSize.width),
    y1: clamp01(y / slideSize.height),
    x2: clamp01((x + width) / slideSize.width),
    y2: clamp01((y + height) / slideSize.height),
  };
}

/** 解析 PowerPoint 表格及 gridSpan/rowSpan 合并信息。 */
function readPptTable(
  $: ReturnType<typeof load>,
  tableNode: ReturnType<ReturnType<typeof load>>,
): DocumentTable | null {
  const rows: string[][] = [];
  const mergedCells: DocumentTable['mergedCells'] = [];
  tableNode.find('a\\:tr').each((rowIndex, rowElement) => {
    const row: string[] = [];
    $(rowElement)
      .children('a\\:tc')
      .each((columnIndex, cellElement) => {
        const cell = $(cellElement);
        row.push(
          cell
            .find('a\\:t')
            .toArray()
            .map((item) => $(item).text())
            .join('\n'),
        );
        const properties = cell.find('a\\:tcPr').first();
        const rowSpan = positiveInteger(properties.attr('rowSpan'));
        const columnSpan = positiveInteger(properties.attr('gridSpan'));
        if (rowSpan > 1 || columnSpan > 1) {
          mergedCells.push({ row: rowIndex, column: columnIndex, rowSpan, columnSpan });
        }
      });
    if (row.length > 0) rows.push(row);
  });
  const width = Math.max(0, ...rows.map((row) => row.length));
  for (const row of rows) while (row.length < width) row.push('');
  return rows.length > 0 ? { rows, headerRowCount: 1, mergedCells: [...mergedCells] } : null;
}

/** 读取 slide rels，把 rId 映射到安全归一化的 ppt/media 条目。 */
function readSlideRelationships(
  entries: ReadonlyMap<string, Uint8Array>,
  slideName: string,
): ReadonlyMap<string, string> {
  const fileName = posix.basename(slideName);
  const relationshipName = `${posix.dirname(slideName)}/_rels/${fileName}.rels`;
  const bytes = entries.get(relationshipName);
  if (!bytes) return new Map();
  const $ = load(new TextDecoder().decode(bytes), { xmlMode: true });
  const relationships = new Map<string, string>();
  $('Relationship').each((_index, element) => {
    const node = $(element);
    if (node.attr('TargetMode')?.toLowerCase() === 'external') return;
    const id = node.attr('Id');
    const target = node.attr('Target');
    if (!id || !target) return;
    const normalized = posix.normalize(posix.join(posix.dirname(slideName), target));
    if (normalized.startsWith('ppt/media/')) relationships.set(id, normalized);
  });
  return relationships;
}

/** 从 slideN.xml 稳定得到一基幻灯片号。 */
function slideNumber(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
}

/** 合并字段只接受正整数。 */
function positiveInteger(value: string | undefined): number {
  const parsed = Number(value ?? 1);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** 内嵌媒体像素累计；损坏图片保留 OCR 候选，由 OCR 明确报告。 */
function sumMediaPixels(
  names: readonly string[],
  entries: ReadonlyMap<string, Uint8Array>,
): number {
  let total = 0;
  for (const name of names) {
    const bytes = entries.get(name);
    if (!bytes) continue;
    try {
      const dimensions = readImageDimensions(bytes);
      if (dimensions.width && dimensions.height) total += dimensions.width * dimensions.height;
    } catch {
      // 不吞掉原生文本；该媒体仍在候选列表中。
    }
  }
  return total;
}

/** 媒体后缀到 MIME 的有限映射。 */
function mediaTypeFromName(name: string): string | null {
  const extension = name.split('.').at(-1)?.toLowerCase();
  const types: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    bmp: 'image/bmp',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return extension ? (types[extension] ?? null) : null;
}
