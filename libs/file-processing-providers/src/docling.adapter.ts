/**
 * Docling Serve 开源 Adapter。
 * 外网开发可连接独立 Docling 容器；内网只需把配置切到企业 Parser/OCR HTTP 契约。
 *
 * @requirement PAR-004
 * @requirement PAR-005
 * @requirement PAR-006
 * @requirement PAR-007
 * @requirement PAR-011
 */
import type { OcrPort, ParserPort, ProviderDocumentSource } from '@rag/application';
import type {
  FileStructureInspection,
  OcrResult,
  ParsedBlockCandidate,
  ParserResult,
  ProcessingProviderProfile,
} from '@rag/contracts';
import { OcrResultSchema, ParserResultSchema } from '@rag/contracts';
import { z } from 'zod';
import type { FetchImplementation, ProviderHttpClientConfig } from './http-json.client';
import { postProviderJson } from './http-json.client';
import { ProcessingProviderError } from './provider.error';

export interface DoclingConfig extends ProviderHttpClientConfig {
  readonly profileId: string;
  readonly revision: string;
  readonly protocolVersion: string;
}

const DoclingResponseSchema = z
  .object({
    document: z
      .object({ json_content: z.union([z.string(), z.record(z.string(), z.unknown())]) })
      .passthrough(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Docling 的普通解析模式关闭 OCR，OCR 是否需要由平台按页覆盖率决定。 */
export class DoclingParserAdapter implements ParserPort {
  public constructor(
    private readonly config: DoclingConfig,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public profile(): ProcessingProviderProfile {
    return doclingProfile('PARSER', this.config, ['LAYOUT', 'TABLE_STRUCTURE', 'BBOX']);
  }

  public async parse(source: ProviderDocumentSource, signal: AbortSignal): Promise<ParserResult> {
    const startedAt = Date.now();
    const document = await callDocling(
      this.config,
      source,
      { do_ocr: false, table_mode: 'accurate' },
      signal,
      this.fetchImplementation,
    );
    return ParserResultSchema.parse({
      parserName: 'Docling Serve',
      parserRevision: this.config.revision,
      protocolVersion: this.config.protocolVersion,
      ...mapDoclingDocument(document),
      durationMs: Date.now() - startedAt,
      warnings: ['STRUCTURE_INSPECTION_LIMITED_DOCLING'],
    });
  }
}

/** Docling OCR 按页逐次调用，避免 page_range 把两个稀疏扫描页之间的所有页面重复 OCR。 */
export class DoclingOcrAdapter implements OcrPort {
  public constructor(
    private readonly config: DoclingConfig,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public profile(): ProcessingProviderProfile {
    return doclingProfile('OCR', this.config, ['PAGE_SELECTIVE', 'BBOX']);
  }

  public async recognize(
    source: ProviderDocumentSource,
    pageNumbers: readonly number[],
    signal: AbortSignal,
  ): Promise<OcrResult> {
    const startedAt = Date.now();
    const pages = [];
    for (const pageNo of [...new Set(pageNumbers)].sort((left, right) => left - right)) {
      const document = await callDocling(
        this.config,
        source,
        { do_ocr: true, force_ocr: true, page_range: [pageNo, pageNo], table_mode: 'accurate' },
        signal,
        this.fetchImplementation,
      );
      const mapped = mapDoclingDocument(document);
      pages.push({
        pageNo,
        blocks: mapped.blocks
          .filter((block) => block.pageNo === pageNo || mapped.pages.length === 1)
          .map((block) => ({ ...block, pageNo, confidence: block.confidence ?? 1 })),
        averageConfidence: 1,
      });
    }
    return OcrResultSchema.parse({
      engine: 'Docling OCR',
      engineRevision: this.config.revision,
      protocolVersion: this.config.protocolVersion,
      pages,
      durationMs: Date.now() - startedAt,
      warnings: ['DOCLING_DOES_NOT_EXPOSE_WORD_CONFIDENCE'],
    });
  }
}

async function callDocling(
  config: DoclingConfig,
  source: ProviderDocumentSource,
  options: Record<string, unknown>,
  signal: AbortSignal,
  fetchImplementation: FetchImplementation,
): Promise<Record<string, unknown>> {
  const raw = await postProviderJson(
    config,
    'v1/convert/source',
    {
      sources: [{ kind: 'http', url: source.url }],
      options: { ...options, to_formats: ['json'], from_formats: [doclingFormat(source.format)] },
    },
    signal,
    fetchImplementation,
  );
  const response = DoclingResponseSchema.safeParse(raw);
  if (!response.success) {
    throw new ProcessingProviderError(
      'DEVELOPER_DEFECT',
      'DOCLING_SCHEMA_MISMATCH',
      'Docling Serve 响应结构与 Adapter 不匹配',
      { cause: response.error },
    );
  }
  const json = response.data.document.json_content;
  try {
    return typeof json === 'string' ? (JSON.parse(json) as Record<string, unknown>) : json;
  } catch (error) {
    throw new ProcessingProviderError(
      'DEVELOPER_DEFECT',
      'DOCLING_DOCUMENT_JSON_INVALID',
      'Docling 文档 JSON 无法解析',
      { cause: error },
    );
  }
}

/** 把 Docling 原生 JSON 映射为平台唯一允许向 M04 传递的 Block。 */
export function mapDoclingDocument(
  document: Record<string, unknown>,
): Pick<ParserResult, 'blocks' | 'pages' | 'inspection'> {
  const pagesRecord = asRecord(document.pages);
  const pageSizes = new Map<number, { width: number; height: number }>();
  for (const [key, rawPage] of Object.entries(pagesRecord)) {
    const page = asRecord(rawPage);
    const size = asRecord(page.size);
    const pageNo = numberValue(page.page_no) ?? Number(key);
    const width = numberValue(size.width);
    const height = numberValue(size.height);
    if (Number.isInteger(pageNo) && pageNo > 0 && width && height) {
      pageSizes.set(pageNo, { width, height });
    }
  }

  const rawItems = [
    ...arrayValue(document.texts),
    ...arrayValue(document.tables),
    ...arrayValue(document.pictures),
  ];
  const blocks = rawItems.map((raw) => mapDoclingItem(asRecord(raw), pageSizes));
  blocks.sort(compareCandidate);
  const pageNumbers = new Set<number>(pageSizes.keys());
  for (const block of blocks) if (block.pageNo) pageNumbers.add(block.pageNo);
  const pages = [...pageNumbers]
    .sort((left, right) => left - right)
    .map((pageNo) => {
      const characterCount = blocks
        .filter((block) => block.pageNo === pageNo)
        .reduce((sum, block) => sum + block.text.length, 0);
      return {
        pageNo,
        textCharacterCount: characterCount,
        textCoverage: Math.min(characterCount / 2_000, 1),
        imageOnly: characterCount === 0,
      };
    });
  const inspection: FileStructureInspection = {
    encrypted: false,
    hasMacros: false,
    embeddedObjectCount: 0,
    externalLinkCount: 0,
    archiveDepth: null,
    compressedSizeBytes: null,
    uncompressedSizeBytes: null,
    pageCount: pages.length || null,
    totalPixels: null,
    tableCellCount: blocks.reduce(
      (sum, block) => sum + (block.table?.rows.reduce((count, row) => count + row.length, 0) ?? 0),
      0,
    ),
  };
  return { blocks, pages, inspection };
}

function mapDoclingItem(
  item: Record<string, unknown>,
  pageSizes: ReadonlyMap<number, { width: number; height: number }>,
): ParsedBlockCandidate {
  const provenance = asRecord(arrayValue(item.prov)[0]);
  const pageNo = numberValue(provenance.page_no);
  const table = mapDoclingTable(asRecord(item.data));
  const label = String(item.label ?? 'paragraph').toLowerCase();
  const originalText = String(item.orig ?? item.text ?? table?.rows.flat().join(' | ') ?? '');
  return {
    type: mapDoclingLabel(label, Boolean(table)),
    text: String(item.text ?? table?.rows.map((row) => row.join(' | ')).join('\n') ?? ''),
    originalText,
    pageNo: pageNo && pageNo > 0 ? pageNo : null,
    sheetName: typeof item.sheet_name === 'string' ? item.sheet_name : null,
    slideNo: numberValue(item.slide_no),
    bbox: normalizeDoclingBox(
      asRecord(provenance.bbox),
      pageNo ? pageSizes.get(pageNo) : undefined,
    ),
    headingLevel: label === 'section_header' ? Math.min(numberValue(item.level) ?? 2, 6) : null,
    confidence: null,
    table,
    metadata: { doclingLabel: label, selfRef: String(item.self_ref ?? '') },
  };
}

function mapDoclingTable(data: Record<string, unknown>): ParsedBlockCandidate['table'] {
  const cells = arrayValue(data.table_cells).map((cell) => asRecord(cell));
  if (cells.length === 0) return null;
  const rowCount = Math.max(...cells.map((cell) => numberValue(cell.end_row_offset_idx) ?? 1));
  const columnCount = Math.max(...cells.map((cell) => numberValue(cell.end_col_offset_idx) ?? 1));
  if (rowCount <= 0 || columnCount <= 0) return null;
  const rows = Array.from({ length: rowCount }, () => Array(columnCount).fill('') as string[]);
  const mergedCells = [];
  for (const cell of cells) {
    const row = numberValue(cell.start_row_offset_idx) ?? 0;
    const column = numberValue(cell.start_col_offset_idx) ?? 0;
    const endRow = numberValue(cell.end_row_offset_idx) ?? row + 1;
    const endColumn = numberValue(cell.end_col_offset_idx) ?? column + 1;
    const targetRow = rows[row];
    if (targetRow && column < targetRow.length) targetRow[column] = String(cell.text ?? '');
    if (endRow - row > 1 || endColumn - column > 1) {
      mergedCells.push({ row, column, rowSpan: endRow - row, columnSpan: endColumn - column });
    }
  }
  return {
    rows,
    headerRowCount: cells.some((cell) => cell.column_header === true) ? 1 : 0,
    mergedCells,
  };
}

function normalizeDoclingBox(
  box: Record<string, unknown>,
  pageSize: { width: number; height: number } | undefined,
): ParsedBlockCandidate['bbox'] {
  if (!pageSize) return null;
  const left = numberValue(box.l);
  const top = numberValue(box.t);
  const right = numberValue(box.r);
  const bottom = numberValue(box.b);
  if ([left, top, right, bottom].some((value) => value === null)) return null;
  const origin = String(box.coord_origin ?? 'TOPLEFT').toUpperCase();
  const y1 = origin.includes('BOTTOM') ? pageSize.height - (bottom ?? 0) : (top ?? 0);
  const y2 = origin.includes('BOTTOM') ? pageSize.height - (top ?? 0) : (bottom ?? 0);
  return {
    x1: clamp01((left ?? 0) / pageSize.width),
    y1: clamp01(y1 / pageSize.height),
    x2: clamp01((right ?? 0) / pageSize.width),
    y2: clamp01(y2 / pageSize.height),
  };
}

function mapDoclingLabel(label: string, isTable: boolean): ParsedBlockCandidate['type'] {
  if (isTable || label === 'table') return 'TABLE';
  const labels: Record<string, ParsedBlockCandidate['type']> = {
    title: 'TITLE',
    section_header: 'TITLE',
    list_item: 'LIST',
    picture: 'IMAGE',
    caption: 'CAPTION',
    code: 'CODE',
    formula: 'FORMULA',
    page_header: 'HEADER',
    page_footer: 'FOOTER',
    footnote: 'FOOTNOTE',
  };
  return labels[label] ?? 'PARAGRAPH';
}

function compareCandidate(left: ParsedBlockCandidate, right: ParsedBlockCandidate): number {
  const pageDifference =
    (left.pageNo ?? Number.MAX_SAFE_INTEGER) - (right.pageNo ?? Number.MAX_SAFE_INTEGER);
  if (pageDifference !== 0) return pageDifference;
  if (left.bbox && right.bbox) return left.bbox.y1 - right.bbox.y1 || left.bbox.x1 - right.bbox.x1;
  return 0;
}

function doclingProfile(
  kind: 'PARSER' | 'OCR',
  config: DoclingConfig,
  capabilities: string[],
): ProcessingProviderProfile {
  return {
    kind,
    adapter: 'docling',
    profileId: config.profileId,
    revision: config.revision,
    protocolVersion: config.protocolVersion,
    endpoint: config.baseUrl,
    capabilities,
    timeoutMs: config.timeoutMs,
  };
}

function doclingFormat(format: ProviderDocumentSource['format']): string {
  const formats: Record<ProviderDocumentSource['format'], string> = {
    PDF: 'pdf',
    DOCX: 'docx',
    XLSX: 'xlsx',
    PPTX: 'pptx',
    IMAGE: 'image',
    HTML: 'html',
    MARKDOWN: 'md',
    TEXT: 'text',
    CSV: 'csv',
  };
  return formats[format];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
