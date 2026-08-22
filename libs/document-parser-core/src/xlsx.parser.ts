/**
 * XLSX Parser：safe-ooxml 先完成 ZIP/宏/外链/嵌入对象检查，ExcelJS 再读取 Sheet、公式缓存值、
 * 合并单元格和内嵌图片位置。每个 Sheet 输出标题和 TABLE Block，不把工作表直接切成最终 Chunk。
 * 稀疏工作表只物化实际行，避免恶意远端单元格坐标制造百万空行。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 */
import ExcelJS from 'exceljs';
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

/** 现代 Excel OOXML Parser。 */
export class XlsxDocumentParser implements DocumentFormatParser {
  public readonly format = 'XLSX' as const;

  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    signal: AbortSignal,
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
    if (workbook.worksheets.length > limits.maxPages) {
      throw new DocumentParserError('PAGE_LIMIT_EXCEEDED', 'XLSX Sheet 数量超过安全上限');
    }

    const blocks: ParsedBlockCandidate[] = [];
    const ocrCandidates: OcrTarget[] = [];
    let tableCellCount = 0;
    for (const worksheet of workbook.worksheets) {
      throwIfAborted(signal);
      blocks.push(
        createBlock('TITLE', worksheet.name, {
          sheetName: worksheet.name,
          headingLevel: 1,
          metadata: { extractionSource: 'NATIVE', sheetId: worksheet.id },
        }),
      );
      const tableOutput = worksheetToTable(worksheet, limits.maxTableCells - tableCellCount);
      if (tableOutput) {
        const cells = tableOutput.table.rows.reduce((sum, row) => sum + row.length, 0);
        tableCellCount += cells;
        if (tableCellCount > limits.maxTableCells) {
          throw new DocumentParserError('TABLE_CELL_LIMIT_EXCEEDED', 'XLSX 单元格数量超过安全上限');
        }
        blocks.push(
          createBlock('TABLE', tableOutput.table.rows.map((row) => row.join(' | ')).join('\n'), {
            sheetName: worksheet.name,
            table: tableOutput.table,
            metadata: {
              extractionSource: 'NATIVE',
              sheetId: worksheet.id,
              // 展示文本采用公式缓存结果；公式本身保留在元数据，便于审计和重新计算。
              formulas: tableOutput.formulas,
            },
          }),
        );
      }

      for (const [imageIndex, image] of worksheet.getImages().entries()) {
        const range = image.range as unknown as {
          tl?: { nativeCol?: number; nativeRow?: number; col?: number; row?: number };
          br?: { nativeCol?: number; nativeRow?: number; col?: number; row?: number };
        };
        const bbox = normalizeWorksheetImageRange(range, worksheet.columnCount, worksheet.rowCount);
        const archiveEntryPath = findMediaEntry(archive.entryNames, Number(image.imageId));
        ocrCandidates.push({
          targetId: `xlsx-${worksheet.id}-image-${imageIndex + 1}`,
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

    const mediaEntries = archive.entryNames.filter((name) => name.startsWith('xl/media/'));
    const totalPixels = sumMediaPixels(mediaEntries, archive.entries);
    if (totalPixels > limits.maxTotalPixels) {
      throw new DocumentParserError('PIXEL_LIMIT_EXCEEDED', 'XLSX 内嵌图片总像素超过安全上限');
    }
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
        totalPixels,
        tableCellCount,
      },
      warnings: ocrCandidates.length > 0 ? ['XLSX_EMBEDDED_IMAGES_REQUIRE_OCR_POLICY'] : [],
    };
  }
}

/** Sheet 表格与公式审计事实。 */
interface WorksheetTableOutput {
  readonly table: DocumentTable;
  readonly formulas: readonly { cell: string; formula: string; result: string | null }[];
}

/** 把实际存在的行映射为二维表，并保留可映射到输出行的合并范围。 */
function worksheetToTable(
  worksheet: ExcelJS.Worksheet,
  maximumCells: number,
): WorksheetTableOutput | null {
  const materialized: { sourceRow: number; cells: string[] }[] = [];
  const formulas: { cell: string; formula: string; result: string | null }[] = [];
  let widestRow = 0;
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    // `includeEmpty: true` 会从第一列迭代到最远单元格；必须在调用它之前拦截恶意远端坐标。
    widestRow = Math.max(widestRow, row.cellCount);
    if (widestRow * (materialized.length + 1) > maximumCells) {
      throw new DocumentParserError('TABLE_CELL_LIMIT_EXCEEDED', 'XLSX 单元格数量超过安全上限');
    }
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      while (cells.length < columnNumber - 1) cells.push('');
      cells[columnNumber - 1] =
        cell.isMerged && cell.master.address !== cell.address ? '' : stringifyCellValue(cell.value);
      const formula = readCellFormula(cell.value);
      if (formula) formulas.push({ cell: cell.address, ...formula });
    });
    materialized.push({ sourceRow: rowNumber, cells });
  });
  if (materialized.length === 0) return null;
  const width = Math.max(...materialized.map((row) => row.cells.length));
  for (const row of materialized) while (row.cells.length < width) row.cells.push('');
  const sourceRowToOutput = new Map(materialized.map((row, index) => [row.sourceRow, index]));
  const model = worksheet.model as unknown as { merges?: string[] };
  const mergedCells = (model.merges ?? [])
    .map(parseExcelRange)
    .filter((range): range is NonNullable<typeof range> => range !== null)
    .flatMap((range) => {
      const outputRow = sourceRowToOutput.get(range.startRow);
      return outputRow === undefined
        ? []
        : [
            {
              row: outputRow,
              column: range.startColumn - 1,
              rowSpan: range.endRow - range.startRow + 1,
              columnSpan: range.endColumn - range.startColumn + 1,
            },
          ];
    });
  return {
    table: { rows: materialized.map((row) => row.cells), headerRowCount: 1, mergedCells },
    formulas,
  };
}

/** 公式展示优先缓存结果，但原公式和结果同时进入审计元数据。 */
function readCellFormula(
  value: ExcelJS.CellValue,
): { formula: string; result: string | null } | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    value instanceof Date ||
    Buffer.isBuffer(value)
  )
    return null;
  if ('formula' in value && typeof value.formula === 'string') {
    return {
      formula: value.formula,
      result: value.result === undefined ? null : String(value.result),
    };
  }
  if ('sharedFormula' in value && typeof value.sharedFormula === 'string') {
    return {
      formula: value.sharedFormula,
      result: value.result === undefined ? null : String(value.result),
    };
  }
  return null;
}

/** ExcelJS CellValue 的稳定文本表示，公式优先使用缓存结果并保留公式到 metadata 的前置 `=`。 */
function stringifyCellValue(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return '[BINARY]';
  if ('formula' in value)
    return value.result === undefined ? `=${value.formula}` : String(value.result);
  if ('sharedFormula' in value)
    return value.result === undefined ? `=${value.sharedFormula}` : String(value.result);
  if ('richText' in value) return value.richText.map((item) => item.text).join('');
  if ('hyperlink' in value) return value.text;
  if ('error' in value) return value.error;
  return String(value);
}

/** 将 A1:C3 范围转成一基行列号。 */
function parseExcelRange(value: string): {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
} | null {
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

/** Worksheet 图片 anchor 归一化；缺失 br 时不给出伪造坐标。 */
function normalizeWorksheetImageRange(
  range: {
    tl?: { nativeCol?: number; nativeRow?: number; col?: number; row?: number };
    br?: { nativeCol?: number; nativeRow?: number; col?: number; row?: number };
  },
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

/** ExcelJS imageId 是一基 ID；找不到时返回 null 并交给 OCR 网关显式报能力错误。 */
function findMediaEntry(names: readonly string[], imageId: number): string | null {
  const media = names.filter((name) => name.startsWith('xl/media/')).sort();
  return media[imageId - 1] ?? null;
}

/** 在不解码整图的情况下累计媒体像素。 */
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
      // 损坏图片会在 OCR 阶段明确失败；不影响同一工作簿的原生单元格提取。
    }
  }
  return total;
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
