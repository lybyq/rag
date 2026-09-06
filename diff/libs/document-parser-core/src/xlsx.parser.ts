/**
 * XLSX Parser：先做 OOXML 容器安全检查，再用 ExcelJS 读取工作表值、公式、显示格式和 drawing。
 *
 * 工作表不会机械变成“一张表且第一行必为表头”：完全空白行/列把内容切成多个连续区域，每个
 * TABLE Block 保存源行列映射。图片通过 ExcelJS 已解析的媒体 index/name 关联 ZIP 条目，绝不按
 * `xl/media` 文件名字典序猜测。公式无缓存结果时正文留空并告警，不把表达式冒充计算结果。
 * 本文件不执行公式、不运行宏、不访问外链，也不负责 OCR。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 * @requirement PAR-017
 * @requirement PAR-019
 */
import ExcelJS from 'exceljs';
import type {
  DocumentTable,
  NormalizedBoundingBox,
  OcrTarget,
  ParsedBlockCandidate,
} from '@rag/contracts';
import { readImageDimensions } from './image-dimensions';
import type { ParseResourceBudget } from './parse-resource-budget';
import { readSafeOfficeArchive } from './safe-ooxml';
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, clamp01, createBlock } from './types';

/** 现代 Excel OOXML Parser。 */
export class XlsxDocumentParser implements DocumentFormatParser {
  public readonly format = 'XLSX' as const;

  /** 安全解析工作表区域、单元格事实与图片出现位置。 */
  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    signal: AbortSignal,
    budget: ParseResourceBudget,
  ): Promise<FormatParseOutput> {
    const archive = await readSafeOfficeArchive(input.bytes, 'XLSX', limits, signal);
    const workbook = new ExcelJS.Workbook();
    try {
      const workbookBytes = Buffer.from(
        input.bytes.slice().buffer as ArrayBuffer,
      ) as unknown as Parameters<typeof workbook.xlsx.load>[0];
      await workbook.xlsx.load(workbookBytes);
    } catch (error) {
      throw new DocumentParserError('XLSX_CONTENT_INVALID', 'XLSX 工作簿结构无法解析', {
        cause: error,
      });
    }
    budget.checkpoint();
    if (workbook.worksheets.length > limits.maxPages) {
      throw new DocumentParserError('PAGE_LIMIT_EXCEEDED', 'XLSX Sheet 数量超过安全上限');
    }

    const blocks: ParsedBlockCandidate[] = [];
    const ocrCandidates: OcrTarget[] = [];
    const warnings = new Set<string>();
    const mediaById = readWorkbookMedia(workbook);
    for (const worksheet of workbook.worksheets) {
      budget.checkpoint();
      budget.consumeOutputCharacters(worksheet.name.length);
      blocks.push(
        createBlock('TITLE', worksheet.name, {
          sheetName: worksheet.name,
          headingLevel: 1,
          metadata: { extractionSource: 'NATIVE', sheetId: worksheet.id },
        }),
      );

      for (const tableOutput of worksheetToTables(worksheet, budget, warnings)) {
        const tableText = tableOutput.table.rows.map((row) => row.join(' | ')).join('\n');
        budget.consumeOutputCharacters(tableText.length);
        blocks.push(
          createBlock('TABLE', tableText, {
            sheetName: worksheet.name,
            table: tableOutput.table,
            metadata: {
              extractionSource: 'NATIVE',
              sheetId: worksheet.id,
              sourceRange: tableOutput.sourceRange,
              sourceRowNumbers: tableOutput.sourceRowNumbers,
              sourceColumnNumbers: tableOutput.sourceColumnNumbers,
              headerInference: tableOutput.headerInference,
              formulas: tableOutput.formulas,
              formattedCells: tableOutput.formattedCells,
            },
          }),
        );
      }

      for (const [imageIndex, image] of worksheet.getImages().entries()) {
        budget.checkpoint();
        const range = image.range as unknown as WorksheetImageRange;
        const bbox = normalizeWorksheetImageRange(range, worksheet.columnCount, worksheet.rowCount);
        const media = mediaById.get(Number(image.imageId));
        const archiveEntryPath = media ? resolveMediaEntry(archive.entryNames, media) : null;
        if (!media || !archiveEntryPath) warnings.add('XLSX_IMAGE_ASSET_UNRESOLVED');
        const targetId = `xlsx-sheet-${worksheet.id}-drawing-${imageIndex + 1}-media-${String(
          media?.index ?? image.imageId,
        )}`;
        const sourceAnchor = sourceImageAnchor(range);
        blocks.push(
          createBlock('IMAGE', '', {
            sheetName: worksheet.name,
            bbox,
            metadata: {
              extractionSource: 'NATIVE',
              sheetId: worksheet.id,
              drawingIndex: imageIndex + 1,
              mediaIndex: media?.index ?? null,
              archiveEntryPath,
              sourceAnchor,
              ocrTargetId: targetId,
            },
          }),
        );
        ocrCandidates.push({
          targetId,
          kind: 'EMBEDDED_IMAGE',
          pageNo: null,
          slideNo: null,
          sheetName: worksheet.name,
          bbox,
          assetRef: archiveEntryPath
            ? {
                storage: 'SOURCE_ARCHIVE_ENTRY',
                archiveEntryPath,
                mediaType: mediaTypeFromName(archiveEntryPath),
              }
            : null,
          reason: 'EMBEDDED_SCREENSHOT',
        });
      }
    }

    const mediaEntries = archive.entryNames.filter(
      (name) => name.startsWith('xl/media/') && !name.endsWith('/'),
    );
    if (sumMediaPixels(mediaEntries, archive.entries, budget) > 0) {
      warnings.add('XLSX_MEDIA_DIMENSIONS_UNREADABLE');
    }
    if (ocrCandidates.length > 0) warnings.add('XLSX_EMBEDDED_IMAGES_REQUIRE_OCR_POLICY');
    const budgetFacts = budget.facts();
    return {
      blocks,
      pages: [],
      ocrCandidates,
      inspection: {
        encrypted: archive.encrypted,
        hasMacros: archive.hasMacros,
        embeddedObjectCount: archive.embeddedObjectCount,
        externalLinkCount: archive.externalLinkCount,
        archiveDepth: archive.archiveDepth,
        compressedSizeBytes: archive.compressedSizeBytes,
        uncompressedSizeBytes: archive.uncompressedSizeBytes,
        pageCount: null,
        totalPixels: budgetFacts.totalPixels,
        tableCellCount: budgetFacts.actualTableCells,
      },
      warnings: [...warnings],
    };
  }
}

/** ExcelJS drawing anchor 的最小稳定字段。 */
interface WorksheetImageRange {
  readonly tl?: {
    readonly nativeCol?: number;
    readonly nativeRow?: number;
    readonly col?: number;
    readonly row?: number;
  };
  readonly br?: {
    readonly nativeCol?: number;
    readonly nativeRow?: number;
    readonly col?: number;
    readonly row?: number;
  };
}

/** ExcelJS 从 workbook media 恢复的资产事实；index 就是 worksheet imageId。 */
interface WorkbookMediaFact {
  readonly index: number;
  readonly name: string;
  readonly extension: string;
}

/** 一个连续业务区域映射出的表格与审计元数据。 */
interface WorksheetTableOutput {
  readonly table: DocumentTable;
  readonly sourceRange: string;
  readonly sourceRowNumbers: readonly number[];
  readonly sourceColumnNumbers: readonly number[];
  readonly headerInference: 'HEURISTIC_TEXT_THEN_VALUE' | 'NONE';
  readonly formulas: readonly FormulaFact[];
  readonly formattedCells: readonly FormattedCellFact[];
}

/** 公式表达式与缓存结果必须分开，MISSING 不允许进入展示正文。 */
interface FormulaFact {
  readonly cell: string;
  readonly formula: string;
  readonly result: string | null;
  readonly resultStatus: 'CACHED' | 'MISSING';
}

/** 非 General 单元格的源值、格式串和稳定显示文本。 */
interface FormattedCellFact {
  readonly cell: string;
  readonly rawValue: string | number | boolean | null;
  readonly numberFormat: string;
  readonly displayText: string;
}

/** 已解析的合并范围。 */
interface ExcelRange {
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
}

/** 连续源坐标矩形。 */
interface WorksheetRegion {
  readonly startRow: number;
  readonly endRow: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

/**
 * 从非空单元格与合并范围建立连续区域。
 * 空白行/列是区域分隔符；区域面积先过预算，再调用 getCell 创建完整矩阵。
 */
function worksheetToTables(
  worksheet: ExcelJS.Worksheet,
  budget: ParseResourceBudget,
  warnings: Set<string>,
): readonly WorksheetTableOutput[] {
  const usedColumnsByRow = new Map<number, Set<number>>();
  const markUsed = (row: number, column: number): void => {
    const columns = usedColumnsByRow.get(row) ?? new Set<number>();
    columns.add(column);
    usedColumnsByRow.set(row, columns);
  };

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    budget.checkpoint();
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      budget.assertTableShape(rowNumber, columnNumber);
      markUsed(rowNumber, columnNumber);
      if (!(cell.isMerged && cell.master.address !== cell.address)) {
        budget.consumeTableCells(1, 0);
      }
    });
  });

  const model = worksheet.model as unknown as { merges?: readonly string[] };
  const merges = (model.merges ?? [])
    .map(parseExcelRange)
    .filter((range): range is ExcelRange => range !== null);
  for (const range of merges) {
    const rowSpan = range.endRow - range.startRow + 1;
    const columnSpan = range.endColumn - range.startColumn + 1;
    const expandedCells = budget.assertTableSpan(rowSpan, columnSpan);
    budget.assertTableShape(range.endRow, range.endColumn);
    // 先为合并展开保留预算，再创建 used 坐标，防止多个大 merge 绕过累计限制。
    budget.consumeTableCells(0, expandedCells);
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let column = range.startColumn; column <= range.endColumn; column += 1) {
        markUsed(row, column);
      }
    }
  }

  const regions = findWorksheetRegions(usedColumnsByRow);
  return regions.map((region) => buildWorksheetTable(worksheet, region, merges, budget, warnings));
}

/** 先按连续行分带，再按带内连续列分区，稳定支持上下/左右多表。 */
function findWorksheetRegions(
  usedColumnsByRow: ReadonlyMap<number, ReadonlySet<number>>,
): readonly WorksheetRegion[] {
  const rowBands = contiguousRanges([...usedColumnsByRow.keys()].sort((a, b) => a - b));
  const regions: WorksheetRegion[] = [];
  for (const [startRow, endRow] of rowBands) {
    const usedColumns = new Set<number>();
    for (let row = startRow; row <= endRow; row += 1) {
      for (const column of usedColumnsByRow.get(row) ?? []) usedColumns.add(column);
    }
    for (const [startColumn, endColumn] of contiguousRanges(
      [...usedColumns].sort((a, b) => a - b),
    )) {
      regions.push({ startRow, endRow, startColumn, endColumn });
    }
  }
  return regions;
}

/** 构造单个区域的矩阵、公式/格式事实、表头结论和源坐标映射。 */
function buildWorksheetTable(
  worksheet: ExcelJS.Worksheet,
  region: WorksheetRegion,
  merges: readonly ExcelRange[],
  budget: ParseResourceBudget,
  warnings: Set<string>,
): WorksheetTableOutput {
  const rowCount = region.endRow - region.startRow + 1;
  const columnCount = region.endColumn - region.startColumn + 1;
  const regionArea = budget.tableArea(rowCount, columnCount);
  const mergeArea = merges
    .filter((range) => rangeInsideRegion(range, region))
    .reduce(
      (sum, range) =>
        sum + (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1),
      0,
    );
  budget.consumeTableCells(0, Math.max(0, regionArea - mergeArea));

  const rows: string[][] = [];
  const formulas: FormulaFact[] = [];
  const formattedCells: FormattedCellFact[] = [];
  for (let sourceRow = region.startRow; sourceRow <= region.endRow; sourceRow += 1) {
    budget.checkpoint();
    const row: string[] = [];
    for (
      let sourceColumn = region.startColumn;
      sourceColumn <= region.endColumn;
      sourceColumn += 1
    ) {
      const cell = worksheet.getCell(sourceRow, sourceColumn);
      if (cell.isMerged && cell.master.address !== cell.address) {
        row.push('');
        continue;
      }
      const rendered = renderCell(cell);
      row.push(rendered.displayText);
      if (rendered.formula) {
        formulas.push(rendered.formula);
        if (rendered.formula.resultStatus === 'MISSING') {
          warnings.add('XLSX_FORMULA_RESULT_MISSING');
        }
      }
      if (rendered.formatted) formattedCells.push(rendered.formatted);
    }
    rows.push(row);
  }

  const mergedCells = merges
    .filter((range) => rangeInsideRegion(range, region))
    .map((range) => ({
      row: range.startRow - region.startRow,
      column: range.startColumn - region.startColumn,
      rowSpan: range.endRow - range.startRow + 1,
      columnSpan: range.endColumn - range.startColumn + 1,
    }));
  const headerRowCount = inferHeaderRowCount(worksheet, region);
  return {
    table: { rows, headerRowCount, mergedCells },
    sourceRange: `${cellAddress(region.startRow, region.startColumn)}:${cellAddress(
      region.endRow,
      region.endColumn,
    )}`,
    sourceRowNumbers: integerRange(region.startRow, region.endRow),
    sourceColumnNumbers: integerRange(region.startColumn, region.endColumn),
    headerInference: headerRowCount === 1 ? 'HEURISTIC_TEXT_THEN_VALUE' : 'NONE',
    formulas,
    formattedCells,
  };
}

/** 根据首行文本标签 + 后续数值型事实做保守表头推断；单行区域不臆造表头。 */
function inferHeaderRowCount(worksheet: ExcelJS.Worksheet, region: WorksheetRegion): 0 | 1 {
  if (region.endRow <= region.startRow) return 0;
  const firstRowCells = integerRange(region.startColumn, region.endColumn).map((column) =>
    worksheet.getCell(region.startRow, column),
  );
  const nonEmptyFirst = firstRowCells.filter((cell) => cell.value !== null);
  if (nonEmptyFirst.length === 0 || !nonEmptyFirst.every(isTextualCell)) return 0;
  const secondRowCells = integerRange(region.startColumn, region.endColumn).map((column) =>
    worksheet.getCell(region.startRow + 1, column),
  );
  return secondRowCells.some(hasNonTextSemanticValue) ? 1 : 0;
}

/** 生成单元格稳定展示文本，同时返回公式和非 General 格式审计事实。 */
function renderCell(cell: ExcelJS.Cell): {
  readonly displayText: string;
  readonly formula: FormulaFact | null;
  readonly formatted: FormattedCellFact | null;
} {
  const formulaValue = readFormulaValue(cell.value);
  const sourceValue = formulaValue ? formulaValue.result : cell.value;
  const resultMissing = formulaValue !== null && sourceValue === undefined;
  const displayText = resultMissing ? '' : formatCellScalar(sourceValue, cell.numFmt);
  const formula = formulaValue
    ? {
        cell: cell.address,
        formula: formulaValue.formula,
        result: resultMissing ? null : displayText,
        resultStatus: resultMissing ? ('MISSING' as const) : ('CACHED' as const),
      }
    : null;
  const hasExplicitFormat = Boolean(cell.numFmt && cell.numFmt !== 'General');
  const formatted =
    hasExplicitFormat || formulaValue !== null || sourceValue instanceof Date
      ? {
          cell: cell.address,
          rawValue: scalarAuditValue(sourceValue),
          numberFormat: cell.numFmt || 'General',
          displayText,
        }
      : null;
  return { displayText, formula, formatted };
}

/** 读取普通/共享公式及缓存值；undefined 明确表示 Provider 未提供计算结果。 */
function readFormulaValue(
  value: ExcelJS.CellValue,
): { readonly formula: string; readonly result: unknown } | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    value instanceof Date ||
    Buffer.isBuffer(value)
  )
    return null;
  if ('formula' in value && typeof value.formula === 'string') {
    return { formula: value.formula, result: value.result };
  }
  if ('sharedFormula' in value && typeof value.sharedFormula === 'string') {
    return { formula: value.sharedFormula, result: value.result };
  }
  return null;
}

/** Excel 值转稳定文本；有限支持业务关键百分比、货币、千分位和前导零格式。 */
function formatCellScalar(value: unknown, numberFormat: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return formatNumber(value, numberFormat);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return '[BINARY]';
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText
        .map((item) =>
          typeof item === 'object' && item !== null && 'text' in item ? String(item.text) : '',
        )
        .join('');
    }
    if ('hyperlink' in value && 'text' in value) return String(value.text);
    if ('error' in value) return String(value.error);
  }
  return String(value);
}

/** 数字格式只解释确定性强的子集，未知复杂自定义格式保留原始数值与 numFmt 供审计。 */
function formatNumber(value: number, numberFormat: string): string {
  const pattern = (numberFormat || 'General').split(';')[value < 0 ? 1 : 0] ?? numberFormat;
  if (!pattern || pattern === 'General') return String(value);
  const percent = pattern.includes('%');
  const adjusted = percent ? value * 100 : value;
  const decimalPattern = pattern.match(/\.([0#]+)/)?.[1] ?? '';
  const requiredDecimals = [...decimalPattern].filter((character) => character === '0').length;
  const maximumDecimals = decimalPattern.length;
  let rendered =
    maximumDecimals > 0
      ? Math.abs(adjusted).toFixed(maximumDecimals)
      : String(Math.trunc(Math.abs(adjusted)));
  if (maximumDecimals > requiredDecimals && rendered.includes('.')) {
    const [integer = '', fraction = ''] = rendered.split('.');
    const trimmed = fraction.replace(/0+$/, '').padEnd(requiredDecimals, '0');
    rendered = trimmed.length > 0 ? `${integer}.${trimmed}` : integer;
  }
  if (pattern.includes(',')) {
    const [integer = '', fraction] = rendered.split('.');
    rendered =
      integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
      (fraction === undefined ? '' : `.${fraction}`);
  }
  const integerMask = pattern.replace(/[^0]/g, '');
  if (!pattern.includes('.') && !pattern.includes(',') && integerMask.length > 1) {
    rendered = rendered.padStart(integerMask.length, '0');
  }
  const currency = pattern.match(/[$€£¥￥]/)?.[0] ?? '';
  const sign = adjusted < 0 ? '-' : '';
  return `${sign}${currency}${rendered}${percent ? '%' : ''}`;
}

/** 元数据只保存 JSON 稳定标量，不把 ExcelJS 对象或 Buffer 直接塞进协议。 */
function scalarAuditValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return formatCellScalar(value, 'General');
}

/** 表头第一行只接受文本语义。 */
function isTextualCell(cell: ExcelJS.Cell): boolean {
  const value = cell.value;
  if (typeof value === 'string') return value.trim().length > 0;
  return (
    typeof value === 'object' &&
    value !== null &&
    !Buffer.isBuffer(value) &&
    ('richText' in value || 'hyperlink' in value)
  );
}

/** 后续行出现数值、日期、布尔或公式缓存值时，第一行文本才可保守视作表头。 */
function hasNonTextSemanticValue(cell: ExcelJS.Cell): boolean {
  const value = cell.value;
  if (typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) return true;
  const formula = readFormulaValue(value);
  return formula !== null && formula.result !== undefined && typeof formula.result !== 'string';
}

/** 使用 ExcelJS media index/name 建立 imageId 映射，不看 ZIP 排序。 */
function readWorkbookMedia(workbook: ExcelJS.Workbook): ReadonlyMap<number, WorkbookMediaFact> {
  const model = workbook.model as unknown as {
    media?: readonly {
      readonly index?: number;
      readonly name?: string;
      readonly extension?: string;
    }[];
  };
  const media = new Map<number, WorkbookMediaFact>();
  for (const [arrayIndex, item] of (model.media ?? []).entries()) {
    const index = item.index ?? arrayIndex;
    if (!Number.isSafeInteger(index) || index < 0 || !item.name || !item.extension) continue;
    media.set(index, { index, name: item.name, extension: item.extension });
  }
  return media;
}

/** 根据媒体真实 name/extension 精确匹配归档条目；不做 image2/image10 字典序映射。 */
function resolveMediaEntry(entryNames: readonly string[], media: WorkbookMediaFact): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(media.name) || !/^[A-Za-z0-9]+$/.test(media.extension)) {
    return null;
  }
  const expected = `xl/media/${media.name}.${media.extension}`.toLowerCase();
  return entryNames.find((name) => name.toLowerCase() === expected) ?? null;
}

/** 将 drawing anchor 转为一基源坐标，便于在 Excel 中定位原图。 */
function sourceImageAnchor(range: WorksheetImageRange): Readonly<Record<string, number>> | null {
  if (!range.tl || !range.br) return null;
  const startColumn = range.tl.nativeCol ?? range.tl.col;
  const startRow = range.tl.nativeRow ?? range.tl.row;
  const endColumn = range.br.nativeCol ?? range.br.col;
  const endRow = range.br.nativeRow ?? range.br.row;
  if ([startColumn, startRow, endColumn, endRow].some((value) => value === undefined)) return null;
  return {
    startColumn: (startColumn as number) + 1,
    startRow: (startRow as number) + 1,
    endColumn: (endColumn as number) + 1,
    endRow: (endRow as number) + 1,
  };
}

/** Worksheet 图片 anchor 归一化；缺失 br 时不给出伪造坐标。 */
function normalizeWorksheetImageRange(
  range: WorksheetImageRange,
  columnCount: number,
  rowCount: number,
): NormalizedBoundingBox | null {
  if (!range.tl || !range.br || columnCount <= 0 || rowCount <= 0) return null;
  const left = range.tl.nativeCol ?? range.tl.col ?? 0;
  const top = range.tl.nativeRow ?? range.tl.row ?? 0;
  const right = range.br.nativeCol ?? range.br.col ?? left;
  const bottom = range.br.nativeRow ?? range.br.row ?? top;
  return {
    x1: clamp01(left / columnCount),
    y1: clamp01(top / rowCount),
    x2: clamp01(right / columnCount),
    y2: clamp01(bottom / rowCount),
  };
}

/** 在不解码整图的情况下累计媒体像素，返回尺寸不可读的资产数量。 */
function sumMediaPixels(
  names: readonly string[],
  entries: ReadonlyMap<string, Uint8Array>,
  budget: ParseResourceBudget,
): number {
  let unreadable = 0;
  for (const name of names) {
    budget.checkpoint();
    const bytes = entries.get(name);
    if (!bytes) continue;
    try {
      const dimensions = readImageDimensions(bytes);
      if (dimensions.width && dimensions.height) {
        budget.consumePixels(dimensions.width, dimensions.height);
      } else unreadable += 1;
    } catch {
      unreadable += 1;
    }
  }
  return unreadable;
}

/** 判断合并范围是否完整落入当前业务区域。 */
function rangeInsideRegion(range: ExcelRange, region: WorksheetRegion): boolean {
  return (
    range.startRow >= region.startRow &&
    range.endRow <= region.endRow &&
    range.startColumn >= region.startColumn &&
    range.endColumn <= region.endColumn
  );
}

/** 将 A1:C3 范围转成一基行列号。 */
function parseExcelRange(value: string): ExcelRange | null {
  const match = value.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return {
    startColumn: columnNumber(match[1] ?? ''),
    startRow: Number(match[2]),
    endColumn: columnNumber(match[3] ?? ''),
    endRow: Number(match[4]),
  };
}

/** Excel 列字母转数字：A=1、Z=26、AA=27。 */
function columnNumber(value: string): number {
  return [...value.toUpperCase()].reduce(
    (sum, character) => sum * 26 + character.charCodeAt(0) - 64,
    0,
  );
}

/** 一基列号转 Excel 字母。 */
function columnLetters(value: number): string {
  let remaining = value;
  let output = '';
  while (remaining > 0) {
    const offset = (remaining - 1) % 26;
    output = String.fromCharCode(65 + offset) + output;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return output;
}

/** 生成 A1 地址。 */
function cellAddress(row: number, column: number): string {
  return `${columnLetters(column)}${row}`;
}

/** 把排序后的整数切成连续闭区间。 */
function contiguousRanges(values: readonly number[]): readonly (readonly [number, number])[] {
  if (values.length === 0) return [];
  const ranges: [number, number][] = [];
  let start = values[0] as number;
  let end = start;
  for (const value of values.slice(1)) {
    if (value === end + 1) end = value;
    else {
      ranges.push([start, end]);
      start = value;
      end = value;
    }
  }
  ranges.push([start, end]);
  return ranges;
}

/** 创建小型闭区间数组；调用前已经通过行列/面积预算。 */
function integerRange(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_unused, index) => start + index);
}

/** 从扩展名映射内嵌媒体 MIME。 */
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
