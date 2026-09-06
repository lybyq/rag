/**
 * PDF 结构 Parser：复用锁定版本 pdf-parse 内部加载的 PDF.js 文档，读取 TextItem、坐标、字体和页面变换。
 * 它恢复行段、分栏阅读顺序、可解释标题、装饰元素与矢量表格，并区分扫描、混合、空白和短文字页。
 * 不渲染整页、不加载远程字体/CMap；标题是带依据的启发式事实，未完成的结构检查必须显式告警。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-007
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 * @requirement PAR-017
 * @requirement PAR-022
 */
import { PDFParse, PasswordException } from 'pdf-parse';
import type {
  NormalizedBoundingBox,
  OcrTarget,
  ParsedBlockCandidate,
  ParsedPage,
} from '@rag/contracts';
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, clamp01, createBlock, throwIfAborted } from './types';
import type { ParseResourceBudget } from './parse-resource-budget';

/** 当前锁定 pdf-parse 2.4.5 所持有的 PDF.js 文档最小能力；升级依赖时由测试验证。 */
interface PdfDocumentModel {
  readonly numPages: number;
  getPage(pageNo: number): Promise<PdfPageModel>;
  getAttachments(): Promise<unknown>;
  getJSActions(): Promise<unknown>;
  getOpenAction(): Promise<unknown>;
}

/** PDF.js 页面最小能力，不把供应商类型泄漏到统一契约。 */
interface PdfPageModel {
  readonly rotate: number;
  getViewport(options: { readonly scale: number }): PdfViewportModel;
  getTextContent(options: {
    readonly includeMarkedContent: boolean;
    readonly disableNormalization: boolean;
  }): Promise<PdfTextContentModel>;
  getOperatorList(): Promise<{
    readonly fnArray: readonly number[];
    readonly argsArray: readonly (readonly unknown[] | null)[];
  }>;
  getJSActions(): Promise<unknown>;
  getStructTree(): Promise<unknown>;
  cleanup(): void;
}

/** 视口已合并 CropBox 与 Rotate，可把 PDF 用户坐标变成左上角页面坐标。 */
interface PdfViewportModel {
  readonly width: number;
  readonly height: number;
  convertToViewportPoint(x: number, y: number): readonly [number, number];
}

/** TextContent 的结构化子集。 */
interface PdfTextContentModel {
  readonly items: readonly unknown[];
  readonly styles: Readonly<
    Record<string, { readonly fontFamily?: string; readonly vertical?: boolean }>
  >;
}

/** 已验证为真实 TextItem 的供应商字段。 */
interface PdfTextItemModel {
  readonly str: string;
  readonly dir: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly fontName: string;
  readonly hasEOL: boolean;
}

/** 归一化后的单个 PDF 字符串片段。 */
interface PositionedTextItem {
  readonly text: string;
  readonly bbox: NormalizedBoundingBox;
  readonly fontSize: number;
  readonly fontName: string;
  readonly fontFamily: string | null;
  readonly direction: string;
  readonly hasEol: boolean;
}

/** 同一视觉基线上的文字段；大水平间隙会拆成左右栏两个 segment。 */
interface PdfTextLine {
  readonly id: string;
  readonly pageNo: number;
  readonly text: string;
  readonly bbox: NormalizedBoundingBox;
  readonly fontSize: number;
  readonly fontName: string;
  readonly fontFamily: string | null;
  readonly rawItemCount: number;
  readonly column: number;
  readonly readingOrder: number;
  readonly decoration: 'HEADER' | 'FOOTER' | null;
}

/** 页面分析先独立完成，随后跨页识别重复页眉页脚和正文基准字号。 */
interface PdfPageAnalysis {
  readonly pageNo: number;
  readonly rotation: number;
  readonly lines: readonly PdfTextLine[];
  readonly hasRasterImage: boolean;
  readonly imagePixels: number;
  readonly structureTreePresent: boolean;
}

/** 矢量表格与命中的原生行一起进入阅读顺序，命中行不会再输出段落。 */
interface PdfTableEvent {
  readonly tableIndex: number;
  readonly rows: string[][];
  readonly matchedLineIds: ReadonlySet<string>;
  readonly readingOrder: number;
  readonly bbox: NormalizedBoundingBox | null;
}

/** 标题判定结果必须携带原因、置信度和算法版本。 */
interface HeadingDecision {
  readonly isHeading: boolean;
  readonly level: number | null;
  readonly confidence: number;
  readonly reasons: readonly string[];
}

/** PDF 文档 Parser。 */
export class PdfDocumentParser implements DocumentFormatParser {
  public readonly format = 'PDF' as const;

  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    signal: AbortSignal,
    budget: ParseResourceBudget,
  ): Promise<FormatParseOutput> {
    throwIfAborted(signal);
    const parser = new PDFParse({
      data: input.bytes.slice(),
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      useWorkerFetch: false,
      useWasm: false,
      stopAtErrors: true,
      maxImageSize: limits.maxTotalPixels,
    });
    const onAbort = (): void => {
      void parser.destroy();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const info = await parser.getInfo({ parsePageInfo: true });
      if (info.total > limits.maxPages) {
        throw new DocumentParserError('PAGE_LIMIT_EXCEEDED', 'PDF 页数超过安全上限');
      }
      const document = loadedPdfDocument(parser);
      const warnings = new Set<string>();

      const tablePages = await parser.getTable().catch(() => {
        warnings.add('PDF_TABLE_DETECTION_FAILED');
        return null;
      });
      throwIfAborted(signal);

      const rawAnalyses: PdfPageAnalysis[] = [];
      let activeActionCount = countObjectEntries(await safeCall(() => document.getJSActions()));
      activeActionCount += (await safeCall(() => document.getOpenAction())) ? 1 : 0;
      for (let pageNo = 1; pageNo <= info.total; pageNo += 1) {
        budget.checkpoint();
        const page = await document.getPage(pageNo);
        try {
          const viewport = page.getViewport({ scale: 1 });
          const textContent = await page.getTextContent({
            includeMarkedContent: true,
            disableNormalization: false,
          });
          const positionedItems = readPositionedTextItems(textContent, viewport, warnings);
          const orderedLines = orderPageLines(pageNo, positionedItems);
          const imageFact = await inspectPageImages(page, budget, warnings);
          activeActionCount += countObjectEntries(await safeCall(() => page.getJSActions()));
          rawAnalyses.push({
            pageNo,
            rotation: normalizeRotation(page.rotate),
            lines: orderedLines,
            hasRasterImage: imageFact.count > 0,
            imagePixels: imageFact.pixels,
            structureTreePresent: Boolean(await safeCall(() => page.getStructTree())),
          });
        } finally {
          page.cleanup();
        }
      }

      const analyses = markRepeatedDecorations(rawAnalyses);
      if (analyses.some((page) => page.lines.some((line) => line.decoration))) {
        warnings.add('PDF_REPEATED_HEADER_FOOTER_IDENTIFIED');
      }
      if (analyses.some((page) => page.structureTreePresent)) {
        warnings.add('PDF_STRUCTURE_TREE_PRESENT');
      }

      const outlineTitles = flattenOutlineTitles(info.outline ?? []);
      const bodyFontSize = dominantBodyFontSize(analyses);
      const headingFontSizes = candidateHeadingFontSizes(analyses, bodyFontSize, outlineTitles);
      const blocks: ParsedBlockCandidate[] = [];
      const pages: ParsedPage[] = [];
      const ocrCandidates: OcrTarget[] = [];
      let tableCellCount = 0;

      for (const analysis of analyses) {
        budget.checkpoint();
        const detectedTables =
          tablePages?.pages.find((page) => page.num === analysis.pageNo)?.tables ?? [];
        const tableEvents = buildTableEvents(analysis.lines, detectedTables, budget);
        tableCellCount = budget.facts().actualTableCells;
        const tableLineIds = new Set(tableEvents.flatMap((event) => [...event.matchedLineIds]));
        const proseLines = analysis.lines.filter((line) => !tableLineIds.has(line.id));
        const paragraphEvents = groupLinesIntoParagraphs(proseLines);
        const events = [
          ...paragraphEvents.map((paragraph) => ({ kind: 'TEXT' as const, ...paragraph })),
          ...tableEvents.map((table) => ({ kind: 'TABLE' as const, ...table })),
        ].sort((left, right) => left.readingOrder - right.readingOrder);

        for (const event of events) {
          if (event.kind === 'TABLE') {
            const tableText = event.rows.map((row) => row.join(' | ')).join('\n');
            budget.consumeOutputCharacters(tableText.length);
            blocks.push(
              createBlock('TABLE', tableText, {
                pageNo: analysis.pageNo,
                bbox: event.bbox,
                table: {
                  rows: event.rows,
                  headerRowCount: event.rows.length > 0 ? 1 : 0,
                  mergedCells: [],
                },
                metadata: {
                  extractionSource: 'NATIVE',
                  tableIndex: event.tableIndex,
                  bboxPrecision: event.bbox ? 'PDF_TEXT_ITEM_UNION' : 'UNAVAILABLE',
                  pageRotation: analysis.rotation,
                },
              }),
            );
            if (event.matchedLineIds.size === 0)
              warnings.add('PDF_TABLE_READING_ORDER_APPROXIMATE');
            continue;
          }

          const heading = decideHeading(
            event.text,
            event.fontSize,
            event.bbox,
            bodyFontSize,
            headingFontSizes,
            outlineTitles,
          );
          budget.consumeOutputCharacters(event.originalText.length);
          const type = event.decoration ?? (heading.isHeading ? 'TITLE' : 'PARAGRAPH');
          blocks.push({
            ...createBlock(type, event.originalText, {
              pageNo: analysis.pageNo,
              bbox: event.bbox,
              headingLevel: heading.level,
              confidence: heading.isHeading ? heading.confidence : null,
              metadata: {
                extractionSource: 'NATIVE',
                lineIds: event.lineIds,
                rawItemCount: event.rawItemCount,
                fontSize: event.fontSize,
                fontName: event.fontName,
                fontFamily: event.fontFamily,
                column: event.column,
                pageRotation: analysis.rotation,
                bboxPrecision: 'PDF_TEXT_ITEM',
                ...(heading.isHeading
                  ? {
                      headingInference: {
                        algorithmRevision: 'pdf-heading-v1',
                        confidence: heading.confidence,
                        reasons: heading.reasons,
                        bodyFontSize,
                      },
                    }
                  : {}),
              },
            }),
            text: event.text,
          });
        }

        const pageBlocks = blocks.filter((block) => block.pageNo === analysis.pageNo);
        const textCharacterCount = pageBlocks.reduce(
          (sum, block) => sum + block.originalText.length,
          0,
        );
        const geometricCoverage = Math.min(
          1,
          analysis.lines.reduce(
            (sum, line) => sum + (line.bbox.x2 - line.bbox.x1) * (line.bbox.y2 - line.bbox.y1),
            0,
          ),
        );
        const textCoverage = Math.max(geometricCoverage, Math.min(1, textCharacterCount / 2_000));
        const garbled = garbledRatio(analysis.lines.map((line) => line.text).join('')) >= 0.25;
        const imageOnly = textCharacterCount === 0 && analysis.hasRasterImage;
        pages.push({ pageNo: analysis.pageNo, textCharacterCount, textCoverage, imageOnly });

        if (imageOnly || garbled || (analysis.hasRasterImage && textCharacterCount < 40)) {
          const reason = imageOnly
            ? 'NO_NATIVE_TEXT'
            : garbled
              ? 'GARBLED_TEXT'
              : 'LOW_TEXT_COVERAGE';
          ocrCandidates.push(pageOcrTarget(analysis.pageNo, reason));
          if (!imageOnly) warnings.add('PDF_MIXED_PAGE_REQUIRES_OCR');
        } else if (textCharacterCount === 0 && !analysis.hasRasterImage) {
          warnings.add('PDF_BLANK_PAGE_FOUND');
        }
      }

      const attachmentResult = await inspectAttachments(document, input.bytes, warnings);
      if (ocrCandidates.some((target) => target.reason === 'NO_NATIVE_TEXT')) {
        warnings.add('PDF_IMAGE_ONLY_PAGES_REQUIRE_OCR');
      }
      if (attachmentResult.count > 0) warnings.add('PDF_EMBEDDED_FILE_FOUND');
      if (activeActionCount > 0) warnings.add('PDF_ACTIVE_ACTION_FOUND');

      const externalLinkCount = info.pages.reduce((sum, page) => sum + page.links.length, 0);
      const annotatedBlocks = annotateCrossPageContinuations(blocks);
      return {
        blocks: annotatedBlocks,
        pages,
        ocrCandidates,
        inspection: {
          encrypted: false,
          hasMacros: activeActionCount > 0,
          embeddedObjectCount: attachmentResult.count,
          externalLinkCount,
          archiveDepth: null,
          compressedSizeBytes: null,
          uncompressedSizeBytes: null,
          pageCount: info.total,
          totalPixels: budget.facts().totalPixels,
          tableCellCount,
          documentTitle: readDocumentTitle(info.info),
          outlineItemCount: outlineTitles.size,
          embeddedObjectInspectionComplete: attachmentResult.complete,
          activeActionCount,
        },
        warnings: [...warnings],
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof DocumentParserError) throw error;
      const passwordProtected =
        error instanceof PasswordException ||
        (error instanceof Error && error.name === 'PasswordException');
      throw new DocumentParserError(
        passwordProtected ? 'PDF_PASSWORD_PROTECTED' : 'PDF_CONTENT_INVALID',
        passwordProtected ? 'PDF 受密码保护，无法安全解析' : 'PDF 文档结构损坏',
        { cause: error },
      );
    } finally {
      signal.removeEventListener('abort', onAbort);
      await parser.destroy();
    }
  }
}

/** pdf-parse 已完成 load 后会持有同一个 PDF.js 文档；缺失意味着锁定依赖 API 已变化。 */
function loadedPdfDocument(parser: PDFParse): PdfDocumentModel {
  const document = (parser as unknown as { readonly doc?: PdfDocumentModel }).doc;
  if (!document || typeof document.getPage !== 'function') {
    throw new DocumentParserError(
      'PDFJS_INTERNAL_API_MISMATCH',
      '锁定版本 pdf-parse 未暴露预期 PDF.js 文档能力',
      { failureClass: 'DEVELOPER_DEFECT', httpStatus: 500 },
    );
  }
  return document;
}

/**
 * 从 operator list 识别内联图片对象和 PDF.js 命名图片资源。
 * pdf-parse 2.4.5 的 getImage 对内联图片会把对象误当资源名等待，因此这里不调用该高层 API。
 */
async function inspectPageImages(
  page: PdfPageModel,
  budget: ParseResourceBudget,
  warnings: Set<string>,
): Promise<{ readonly count: number; readonly pixels: number }> {
  try {
    const operators = await page.getOperatorList();
    let count = 0;
    let pixels = 0;
    const namedImages = new Set<string>();
    for (const args of operators.argsArray) {
      const candidate = args?.[0];
      if (isInlineImageObject(candidate)) {
        count += 1;
        budget.consumePixels(candidate.width, candidate.height);
        pixels += candidate.width * candidate.height;
      } else if (typeof candidate === 'string' && /(?:^|_)img(?:_|-)/i.test(candidate)) {
        // 命名 XObject 的真实宽高不在 operator args 中；仍能可靠判断页面含图，像素保持未知。
        namedImages.add(candidate);
      }
    }
    count += namedImages.size;
    if (namedImages.size > 0) warnings.add('PDF_NAMED_IMAGE_DIMENSIONS_UNAVAILABLE');
    return { count, pixels };
  } catch {
    warnings.add('PDF_IMAGE_INSPECTION_INCOMPLETE');
    return { count: 0, pixels: 0 };
  }
}

/** 内联图片参数直接携带有限正整数宽高。 */
function isInlineImageObject(
  value: unknown,
): value is { readonly width: number; readonly height: number } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return (
    Number.isSafeInteger(candidate.width) &&
    Number(candidate.width) > 0 &&
    Number.isSafeInteger(candidate.height) &&
    Number(candidate.height) > 0 &&
    // PDF.js 对小型 inline image 可能只保留 width/height/interpolate，不保证暴露 data 字段。
    Object.keys(candidate).length > 0
  );
}

/** 把通过运行时字段检查的 TextItem 转成真实页面坐标。 */
function readPositionedTextItems(
  content: PdfTextContentModel,
  viewport: PdfViewportModel,
  warnings: Set<string>,
): readonly PositionedTextItem[] {
  const result: PositionedTextItem[] = [];
  for (const raw of content.items) {
    if (!isPdfTextItem(raw) || raw.str.length === 0) continue;
    const [a, b, c, d, e, f] = raw.transform;
    if (![a, b, c, d, e, f, raw.width, raw.height].every(Number.isFinite)) {
      warnings.add('PDF_TEXT_ITEM_INVALID');
      continue;
    }
    const horizontalLength = Math.hypot(a!, b!);
    const horizontalX = horizontalLength > 0 ? (a! / horizontalLength) * raw.width : raw.width;
    const horizontalY = horizontalLength > 0 ? (b! / horizontalLength) * raw.width : 0;
    const verticalX = c!;
    const verticalY = d!;
    const points = [
      viewport.convertToViewportPoint(e!, f!),
      viewport.convertToViewportPoint(e! + horizontalX, f! + horizontalY),
      viewport.convertToViewportPoint(e! + verticalX, f! + verticalY),
      viewport.convertToViewportPoint(e! + horizontalX + verticalX, f! + horizontalY + verticalY),
    ];
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const x1 = Math.min(...xs);
    const y1 = Math.min(...ys);
    const x2 = Math.max(...xs);
    const y2 = Math.max(...ys);
    result.push({
      text: raw.str,
      bbox: {
        x1: clamp01(x1 / viewport.width),
        y1: clamp01(y1 / viewport.height),
        x2: clamp01(x2 / viewport.width),
        y2: clamp01(y2 / viewport.height),
      },
      fontSize: Math.max(Math.hypot(c!, d!), raw.height, 1),
      fontName: raw.fontName,
      fontFamily: content.styles[raw.fontName]?.fontFamily ?? null,
      direction: raw.dir,
      hasEol: raw.hasEOL,
    });
  }
  return result;
}

/** TextMarkedContent 没有 str/transform；先做结构检查再读取。 */
function isPdfTextItem(value: unknown): value is PdfTextItemModel {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PdfTextItemModel>;
  return (
    typeof item.str === 'string' &&
    Array.isArray(item.transform) &&
    item.transform.length >= 6 &&
    typeof item.width === 'number' &&
    typeof item.height === 'number' &&
    typeof item.fontName === 'string' &&
    typeof item.hasEOL === 'boolean'
  );
}

/** 先聚合同一基线，再按大水平间隙拆 segment，最后执行保守双栏排序。 */
function orderPageLines(
  pageNo: number,
  items: readonly PositionedTextItem[],
): readonly PdfTextLine[] {
  const rows: PositionedTextItem[][] = [];
  for (const item of [...items].sort(comparePositionedItems)) {
    const centerY = (item.bbox.y1 + item.bbox.y2) / 2;
    const row = rows.find((candidate) => {
      const candidateY =
        candidate.reduce((sum, current) => sum + (current.bbox.y1 + current.bbox.y2) / 2, 0) /
        candidate.length;
      const tolerance = Math.max(
        0.004,
        Math.max(...candidate.map((current) => current.bbox.y2 - current.bbox.y1)) * 0.65,
      );
      return Math.abs(candidateY - centerY) <= tolerance;
    });
    (row ?? rows[rows.push([]) - 1]!).push(item);
  }

  const segments: Omit<PdfTextLine, 'column' | 'readingOrder' | 'decoration'>[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const sorted = [...row].sort((left, right) => left.bbox.x1 - right.bbox.x1);
    let current: PositionedTextItem[] = [];
    const flush = (): void => {
      if (current.length === 0) return;
      const segmentIndex = segments.length;
      segments.push(lineFromItems(pageNo, `${pageNo}-${rowIndex}-${segmentIndex}`, current));
      current = [];
    };
    for (const item of sorted) {
      const previous = current.at(-1);
      const gap = previous ? item.bbox.x1 - previous.bbox.x2 : 0;
      if (previous && gap > Math.max(0.12, averageFontSize(current) / 600)) flush();
      current.push(item);
    }
    flush();
  }

  const boundary = detectColumnBoundary(segments);
  const ordered = boundary
    ? [
        ...segments
          .filter((line) => line.bbox.x1 < boundary)
          .sort((left, right) => left.bbox.y1 - right.bbox.y1),
        ...segments
          .filter((line) => line.bbox.x1 >= boundary)
          .sort((left, right) => left.bbox.y1 - right.bbox.y1),
      ]
    : [...segments].sort(
        (left, right) => left.bbox.y1 - right.bbox.y1 || left.bbox.x1 - right.bbox.x1,
      );
  return ordered.map((line, readingOrder) => ({
    ...line,
    column: boundary && line.bbox.x1 >= boundary ? 2 : 1,
    readingOrder,
    decoration: null,
  }));
}

/** TextItem 默认按上到下、再左到右进入基线聚合。 */
function comparePositionedItems(left: PositionedTextItem, right: PositionedTextItem): number {
  return left.bbox.y1 - right.bbox.y1 || left.bbox.x1 - right.bbox.x1;
}

/** 一个 segment 连接相邻 item；依据实际几何间隙决定是否插入空格。 */
function lineFromItems(
  pageNo: number,
  id: string,
  items: readonly PositionedTextItem[],
): Omit<PdfTextLine, 'column' | 'readingOrder' | 'decoration'> {
  let text = '';
  items.forEach((item, index) => {
    const previous = items[index - 1];
    const gap = previous ? item.bbox.x1 - previous.bbox.x2 : 0;
    if (previous && gap > 0.003 && !text.endsWith(' ') && !item.text.startsWith(' ')) text += ' ';
    text += item.text;
  });
  const dominant = [...items].sort((left, right) => right.text.length - left.text.length)[0]!;
  return {
    id,
    pageNo,
    text,
    bbox: unionBoxes(items.map((item) => item.bbox))!,
    fontSize: averageFontSize(items),
    fontName: dominant.fontName,
    fontFamily: dominant.fontFamily,
    rawItemCount: items.length,
  };
}

/** 找到足够宽且两侧都有至少两行的 x 起点间隙，避免把普通缩进误判成双栏。 */
function detectColumnBoundary(lines: readonly Pick<PdfTextLine, 'bbox'>[]): number | null {
  const starts = [...new Set(lines.map((line) => Math.round(line.bbox.x1 * 100) / 100))].sort(
    (left, right) => left - right,
  );
  let best: { gap: number; boundary: number } | null = null;
  for (let index = 1; index < starts.length; index += 1) {
    const left = starts[index - 1]!;
    const right = starts[index]!;
    const gap = right - left;
    const boundary = (left + right) / 2;
    const leftCount = lines.filter((line) => line.bbox.x1 < boundary).length;
    const rightCount = lines.filter((line) => line.bbox.x1 >= boundary).length;
    if (gap >= 0.25 && leftCount >= 2 && rightCount >= 2 && (!best || gap > best.gap)) {
      best = { gap, boundary };
    }
  }
  return best?.boundary ?? null;
}

/** 跨页相同且位于顶部/底部的行标为装饰 Block，下游 Chunking 会排除它。 */
function markRepeatedDecorations(pages: readonly PdfPageAnalysis[]): readonly PdfPageAnalysis[] {
  if (pages.length < 2) return pages;
  const occurrences = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const line of page.lines) {
      const zone = line.bbox.y2 <= 0.12 ? 'HEADER' : line.bbox.y1 >= 0.88 ? 'FOOTER' : null;
      if (!zone) continue;
      const key = `${zone}:${decorationSignature(line.text)}`;
      const pageNumbers = occurrences.get(key) ?? new Set<number>();
      pageNumbers.add(page.pageNo);
      occurrences.set(key, pageNumbers);
    }
  }
  return pages.map((page) => ({
    ...page,
    lines: page.lines.map((line) => {
      const zone = line.bbox.y2 <= 0.12 ? 'HEADER' : line.bbox.y1 >= 0.88 ? 'FOOTER' : null;
      if (!zone) return line;
      const repeated =
        (occurrences.get(`${zone}:${decorationSignature(line.text)}`)?.size ?? 0) >= 2;
      return { ...line, decoration: repeated ? zone : null };
    }),
  }));
}

/** 页码数字归一化，保证“Page 1 / Page 2”能识别为同一个页脚模板。 */
function decorationSignature(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** 以非装饰文本的字符加权字号众数作为正文基准。 */
function dominantBodyFontSize(pages: readonly PdfPageAnalysis[]): number {
  const weights = new Map<number, number>();
  for (const line of pages.flatMap((page) => page.lines)) {
    if (line.decoration) continue;
    const size = Math.round(line.fontSize * 2) / 2;
    weights.set(size, (weights.get(size) ?? 0) + Math.max(1, line.text.length));
  }
  return [...weights.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 12;
}

/** 提前收集候选标题字号，后续相同层级得到一致 headingLevel。 */
function candidateHeadingFontSizes(
  pages: readonly PdfPageAnalysis[],
  bodyFontSize: number,
  outlineTitles: ReadonlySet<string>,
): readonly number[] {
  return [
    ...new Set(
      pages
        .flatMap((page) => page.lines)
        .filter(
          (line) =>
            !line.decoration &&
            (line.fontSize >= bodyFontSize * 1.3 || outlineTitles.has(normalizeText(line.text))),
        )
        .map((line) => Math.round(line.fontSize * 10) / 10),
    ),
  ].sort((left, right) => right - left);
}

/** 表格行与原生 TextItem 行做内容匹配，命中的原生行由 TABLE 替代。 */
function buildTableEvents(
  lines: readonly PdfTextLine[],
  tables: readonly string[][][],
  budget: ParseResourceBudget,
): readonly PdfTableEvent[] {
  return tables.map((sourceRows, tableIndex) => {
    const width = Math.max(0, ...sourceRows.map((row) => row.length));
    const area = budget.tableArea(sourceRows.length, width);
    const actual = sourceRows.reduce((sum, row) => sum + row.length, 0);
    budget.consumeTableCells(actual, area);
    const rows = sourceRows.map((row) => [
      ...row,
      ...Array(Math.max(0, width - row.length)).fill(''),
    ]);
    const rowSignatures = rows.map((row) => normalizeText(row.join(''))).filter(Boolean);
    const cellSignatures = new Set(rows.flat().map(normalizeText).filter(Boolean));
    const matched = lines.filter((line) => {
      const signature = normalizeText(line.text);
      return rowSignatures.includes(signature) || cellSignatures.has(signature);
    });
    return {
      tableIndex,
      rows,
      matchedLineIds: new Set(matched.map((line) => line.id)),
      readingOrder: Math.min(
        ...matched.map((line) => line.readingOrder),
        lines.length + tableIndex,
      ),
      bbox: unionBoxes(matched.map((line) => line.bbox)),
    };
  });
}

/** 相邻、同栏、同字号且行距合理的行合成一个段落；原始行之间保留换行用于审计。 */
function groupLinesIntoParagraphs(lines: readonly PdfTextLine[]): readonly {
  readonly text: string;
  readonly originalText: string;
  readonly bbox: NormalizedBoundingBox;
  readonly fontSize: number;
  readonly fontName: string;
  readonly fontFamily: string | null;
  readonly column: number;
  readonly readingOrder: number;
  readonly lineIds: readonly string[];
  readonly rawItemCount: number;
  readonly decoration: 'HEADER' | 'FOOTER' | null;
}[] {
  const groups: PdfTextLine[][] = [];
  for (const line of lines) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const verticalGap = previous ? line.bbox.y1 - previous.bbox.y2 : Number.POSITIVE_INFINITY;
    const similarFont = previous
      ? Math.abs(line.fontSize - previous.fontSize) / Math.max(line.fontSize, previous.fontSize) <
        0.12
      : false;
    const sameContext =
      previous?.column === line.column &&
      previous.decoration === line.decoration &&
      Math.abs(previous.bbox.x1 - line.bbox.x1) < 0.04;
    if (
      current &&
      previous &&
      similarFont &&
      sameContext &&
      verticalGap >= 0 &&
      verticalGap < 0.018
    ) {
      current.push(line);
    } else {
      groups.push([line]);
    }
  }
  return groups.map((group) => {
    const originalText = group.map((line) => line.text).join('\n');
    const text = joinParagraphLines(group.map((line) => line.text));
    const first = group[0]!;
    return {
      text,
      originalText,
      bbox: unionBoxes(group.map((line) => line.bbox))!,
      fontSize: group.reduce((sum, line) => sum + line.fontSize, 0) / group.length,
      fontName: first.fontName,
      fontFamily: first.fontFamily,
      column: first.column,
      readingOrder: first.readingOrder,
      lineIds: group.map((line) => line.id),
      rawItemCount: group.reduce((sum, line) => sum + line.rawItemCount, 0),
      decoration: first.decoration,
    };
  });
}

/**
 * 只有上一页靠近底部、无结束标点，且下一页靠近顶部并以小写开头时才标连续。
 * 这里只建立双向事实，不把跨页原文直接合并，引用仍能精确落到各自页面。
 */
function annotateCrossPageContinuations(
  blocks: readonly ParsedBlockCandidate[],
): readonly ParsedBlockCandidate[] {
  const result = blocks.map((block) => ({ ...block, metadata: { ...block.metadata } }));
  const pageNumbers = [
    ...new Set(
      result.map((block) => block.pageNo).filter((pageNo): pageNo is number => pageNo !== null),
    ),
  ].sort((left, right) => left - right);
  for (let index = 1; index < pageNumbers.length; index += 1) {
    const previousPage = pageNumbers[index - 1]!;
    const currentPage = pageNumbers[index]!;
    if (currentPage !== previousPage + 1) continue;
    const previous = result
      .filter((block) => block.pageNo === previousPage && block.type === 'PARAGRAPH' && block.bbox)
      .at(-1);
    const current = result.find(
      (block) => block.pageNo === currentPage && block.type === 'PARAGRAPH' && block.bbox,
    );
    if (!previous?.bbox || !current?.bbox) continue;
    const likelyContinuation =
      previous.bbox.y2 >= 0.9 &&
      current.bbox.y1 <= 0.12 &&
      !/[。！？.!?;；:]$/u.test(previous.text.trim()) &&
      /^\p{Ll}/u.test(current.text.trim());
    if (!likelyContinuation) continue;
    previous.metadata = {
      ...previous.metadata,
      continuesOnNextPage: true,
      continuationAlgorithmRevision: 'pdf-cross-page-v1',
    };
    current.metadata = {
      ...current.metadata,
      continuesFromPreviousPage: true,
      continuationAlgorithmRevision: 'pdf-cross-page-v1',
    };
  }
  return result;
}

/** 跨行连字符直接连接，其余行用一个空格；originalText 仍保留真实换行。 */
function joinParagraphLines(lines: readonly string[]): string {
  return lines.reduce((result, line) => {
    if (!result) return line;
    return result.endsWith('-') ? `${result.slice(0, -1)}${line.trimStart()}` : `${result} ${line}`;
  }, '');
}

/** 标题需要多项证据；单纯加粗/短句不会通过阈值。 */
function decideHeading(
  text: string,
  fontSize: number,
  bbox: NormalizedBoundingBox,
  bodyFontSize: number,
  headingFontSizes: readonly number[],
  outlineTitles: ReadonlySet<string>,
): HeadingDecision {
  const reasons: string[] = [];
  let confidence = 0;
  const ratio = fontSize / Math.max(bodyFontSize, 1);
  if (ratio >= 1.3) {
    reasons.push('FONT_SIZE_RATIO');
    confidence += 0.55;
  }
  const numberingLevel = sectionNumberingLevel(text);
  if (numberingLevel !== null) {
    reasons.push('SECTION_NUMBERING');
    confidence += 0.25;
  }
  if (outlineTitles.has(normalizeText(text))) {
    reasons.push('OUTLINE_MATCH');
    confidence += 0.3;
  }
  if (bbox.y1 <= 0.35) {
    reasons.push('UPPER_PAGE_POSITION');
    confidence += 0.1;
  }
  if (text.trim().length <= 100 && !/[。！？.!?;；:]$/u.test(text.trim())) {
    reasons.push('SHORT_NON_SENTENCE');
    confidence += 0.05;
  }
  confidence = Math.min(1, Number(confidence.toFixed(2)));
  const isHeading = confidence >= 0.7;
  const sizeLevel = Math.max(
    1,
    headingFontSizes.findIndex((size) => Math.abs(size - fontSize) < 0.2) + 1,
  );
  return {
    isHeading,
    level: isHeading ? Math.min(6, numberingLevel ?? sizeLevel) : null,
    confidence,
    reasons,
  };
}

/** 1 / 1.2 / 第三章分别提供可解释层级；没有编号返回 null。 */
function sectionNumberingLevel(text: string): number | null {
  const arabic = text.trim().match(/^(\d+(?:\.\d+)*)[.)、]?\s+/u)?.[1];
  if (arabic) return Math.min(6, arabic.split('.').length);
  return /^第[一二三四五六七八九十百千\d]+[编章节]/u.test(text.trim()) ? 1 : null;
}

/** PDF Info Title 单独进入 inspection，不参与正文 TITLE 推断。 */
function readDocumentTitle(info: unknown): string | null {
  if (!info || typeof info !== 'object') return null;
  const title = (info as Readonly<Record<string, unknown>>).Title;
  return typeof title === 'string' && title.trim().length > 0 ? title.trim().slice(0, 500) : null;
}

/** 递归展平 bookmark 标题，仅用于标题证据，不把大纲文字直接写入正文。 */
function flattenOutlineTitles(nodes: readonly unknown[]): ReadonlySet<string> {
  const result = new Set<string>();
  const visit = (items: readonly unknown[]): void => {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Readonly<Record<string, unknown>>;
      if (typeof record.title === 'string') result.add(normalizeText(record.title));
      if (Array.isArray(record.items)) visit(record.items);
    }
  };
  visit(nodes);
  return result;
}

/** PDF.js 附件对象模型优先；调用失败时原始 token 只作下限且标记检查未完成。 */
async function inspectAttachments(
  document: PdfDocumentModel,
  bytes: Uint8Array,
  warnings: Set<string>,
): Promise<{ readonly count: number; readonly complete: boolean }> {
  try {
    const attachments = await document.getAttachments();
    return { count: countObjectEntries(attachments), complete: true };
  } catch {
    warnings.add('PDF_EMBEDDED_OBJECT_INSPECTION_INCOMPLETE');
    return { count: countAsciiToken(bytes, '/EmbeddedFile'), complete: false };
  }
}

/** 文档/页面动作返回对象键；null 和非对象均为 0。 */
function countObjectEntries(value: unknown): number {
  return value && typeof value === 'object' ? Object.keys(value).length : 0;
}

/** 某些 PDF.js 可选能力失败不应删除已恢复正文，但调用方会通过对应 warning/事实判断。 */
async function safeCall<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}

/** 创建整页 OCR 目标；仅用于扫描、乱码或有图且原生文字极少的混合页。 */
function pageOcrTarget(pageNo: number, reason: OcrTarget['reason']): OcrTarget {
  return {
    targetId: `page-${pageNo}`,
    kind: 'PAGE',
    pageNo,
    slideNo: null,
    sheetName: null,
    bbox: null,
    assetRef: {
      storage: 'SOURCE_DOCUMENT',
      archiveEntryPath: null,
      mediaType: 'application/pdf',
    },
    reason,
  };
}

/** 替换字符、非排版控制字符占比过高说明文字映射不可依赖。 */
function garbledRatio(text: string): number {
  if (text.length === 0) return 0;
  const garbled = [...text].filter(
    (character) =>
      character === '\uFFFD' || (/\p{Cc}/u.test(character) && !/[\t\n\r]/u.test(character)),
  ).length;
  return garbled / [...text].length;
}

/** 合并一组归一化 bbox；空集合保持 null。 */
function unionBoxes(boxes: readonly NormalizedBoundingBox[]): NormalizedBoundingBox | null {
  if (boxes.length === 0) return null;
  return {
    x1: Math.min(...boxes.map((box) => box.x1)),
    y1: Math.min(...boxes.map((box) => box.y1)),
    x2: Math.max(...boxes.map((box) => box.x2)),
    y2: Math.max(...boxes.map((box) => box.y2)),
  };
}

/** 字体均值用于同一行多个样式 Run 的保守代表值。 */
function averageFontSize(items: readonly { readonly fontSize: number }[]): number {
  return items.reduce((sum, item) => sum + item.fontSize, 0) / Math.max(items.length, 1);
}

/** 文本匹配忽略空白和大小写，避免表格 cell separator 差异造成去重失败。 */
function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '').trim();
}

/** 页面旋转统一到 0/90/180/270。 */
function normalizeRotation(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** 原始 token 只在 PDF.js 附件对象读取失败时提供保守下限。 */
function countAsciiToken(bytes: Uint8Array, token: string): number {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(token, offset)) >= 0) {
    count += 1;
    offset += token.length;
  }
  return count;
}
