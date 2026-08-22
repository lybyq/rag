/**
 * HTML、Markdown、TXT 与 CSV 的纯 Node Parser。
 * 文本先显式解码，再输出结构化 Block；Markdown 禁用原始 HTML，HTML 删除活动内容且绝不抓取外链。
 * CSV 使用标准状态机库处理引号、换行和转义，并在构造大表前执行单元格上限。
 *
 * @requirement PAR-006
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 * @requirement PAR-013
 */
import { parse as parseCsv } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import MarkdownIt from 'markdown-it';
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, createBlock, emptyInspection, throwIfAborted } from './types';
import { parseHtmlStructure } from './html-structure';

/** HTML 文档 Parser。 */
export class HtmlDocumentParser implements DocumentFormatParser {
  public readonly format = 'HTML' as const;

  public async parse(input: DocumentParserInput): Promise<FormatParseOutput> {
    const structure = parseHtmlStructure(decodeText(input.bytes));
    return {
      ...structure,
      pages: [],
      // HTML/Markdown 中的 img 可能是公网 URL 或 data URL；默认策略不抓取、不送 OCR。
      // 只有拥有归档内稳定二进制引用的 Office 图片，或完整图片文件，才创建 OCR Target。
      ocrCandidates: [],
      inspection: {
        ...emptyInspection(),
        embeddedObjectCount: structure.embeddedObjectCount,
        externalLinkCount: structure.externalLinkCount,
        tableCellCount: structure.tableCellCount,
      },
    };
  }
}

/** CommonMark 风格 Markdown Parser；原始 HTML 被转义，避免脚本进入结构抽取。 */
export class MarkdownDocumentParser implements DocumentFormatParser {
  public readonly format = 'MARKDOWN' as const;
  private readonly markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

  public async parse(input: DocumentParserInput): Promise<FormatParseOutput> {
    const rendered = this.markdown.render(decodeText(input.bytes));
    const structure = parseHtmlStructure(rendered);
    return {
      ...structure,
      pages: [],
      ocrCandidates: [],
      inspection: {
        ...emptyInspection(),
        embeddedObjectCount: structure.embeddedObjectCount,
        externalLinkCount: structure.externalLinkCount,
        tableCellCount: structure.tableCellCount,
      },
    };
  }
}

/** 纯文本 Parser：以空行分段，保留每段 originalText 的原始换行。 */
export class TextDocumentParser implements DocumentFormatParser {
  public readonly format = 'TEXT' as const;

  public async parse(input: DocumentParserInput): Promise<FormatParseOutput> {
    const text = decodeText(input.bytes);
    const blocks = text
      .split(/(?:\r?\n){2,}/)
      .filter((paragraph) => paragraph.trim().length > 0)
      .map((paragraph, index) =>
        createBlock('PARAGRAPH', paragraph, {
          metadata: { extractionSource: 'NATIVE', paragraphIndex: index },
        }),
      );
    return {
      blocks,
      pages: [],
      ocrCandidates: [],
      inspection: { ...emptyInspection(), tableCellCount: 0 },
      warnings: [],
    };
  }
}

/** CSV Parser：整张表作为一个 TABLE Block，首行按表头保留。 */
export class CsvDocumentParser implements DocumentFormatParser {
  public readonly format = 'CSV' as const;

  public async parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    signal: AbortSignal,
  ): Promise<FormatParseOutput> {
    throwIfAborted(signal);
    let records: unknown[][];
    try {
      records = parseCsv(decodeText(input.bytes), {
        bom: true,
        relaxColumnCount: true,
        skipEmptyLines: false,
        maxRecordSize: Math.min(limits.maxXmlEntryBytes, 16 * 1024 * 1024),
      }) as unknown[][];
    } catch (error) {
      if (error instanceof DocumentParserError) throw error;
      throw new DocumentParserError('CSV_CONTENT_INVALID', 'CSV 内容损坏或单条记录超过安全上限', {
        cause: error,
      });
    }
    const rows = records.map((record) => record.map(stringifyCsvValue));
    const cellCount = rows.reduce((sum, row) => sum + row.length, 0);
    if (cellCount > limits.maxTableCells) {
      throw new DocumentParserError('TABLE_CELL_LIMIT_EXCEEDED', 'CSV 表格单元格数量超过安全上限');
    }
    const blocks =
      rows.length === 0
        ? []
        : [
            createBlock('TABLE', rows.map((row) => row.join(' | ')).join('\n'), {
              table: { rows, headerRowCount: 1, mergedCells: [] },
              metadata: { extractionSource: 'NATIVE', delimiter: ',' },
            }),
          ];
    return {
      blocks,
      pages: [],
      ocrCandidates: [],
      inspection: { ...emptyInspection(), tableCellCount: cellCount },
      warnings: [],
    };
  }
}

/** 支持 UTF-8 BOM、UTF-16LE 和 UTF-16BE；无 BOM 时按 UTF-8 严格解码。 */
export function decodeText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return iconv.decode(buffer.subarray(2), 'utf16-le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.byteLength - 2);
    for (let index = 2; index + 1 < buffer.byteLength; index += 2) {
      swapped[index - 2] = buffer[index + 1] ?? 0;
      swapped[index - 1] = buffer[index] ?? 0;
    }
    return iconv.decode(swapped, 'utf16-le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch (error) {
    throw new DocumentParserError(
      'TEXT_ENCODING_UNSUPPORTED',
      '文本编码不是受支持的 UTF-8/UTF-16',
      {
        cause: error,
      },
    );
  }
}

/** CSV 库可能返回 Buffer/Date 等值，统一为可序列化字符串。 */
function stringifyCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}
