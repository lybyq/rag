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
 * @requirement PAR-017
 * @requirement PAR-023
 */
import { parse as parseCsv } from 'csv-parse/sync';
import MarkdownIt from 'markdown-it';
import type {
  DocumentFormatParser,
  DocumentParserInput,
  DocumentParserLimits,
  FormatParseOutput,
} from './types';
import { DocumentParserError, createBlock, emptyInspection, throwIfAborted } from './types';
import { parseHtmlStructure } from './html-structure';
import type { ParseResourceBudget } from './parse-resource-budget';

/** HTML 文档 Parser。 */
export class HtmlDocumentParser implements DocumentFormatParser {
  public readonly format = 'HTML' as const;

  public async parse(
    input: DocumentParserInput,
    _limits: DocumentParserLimits,
    signal: AbortSignal,
    budget: ParseResourceBudget,
  ): Promise<FormatParseOutput> {
    throwIfAborted(signal);
    const structure = parseHtmlStructure(decodeText(input.bytes), budget);
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

  public async parse(
    input: DocumentParserInput,
    _limits: DocumentParserLimits,
    signal: AbortSignal,
    budget: ParseResourceBudget,
  ): Promise<FormatParseOutput> {
    throwIfAborted(signal);
    const rendered = this.markdown.render(decodeText(input.bytes));
    const structure = parseHtmlStructure(rendered, budget);
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

  public async parse(
    input: DocumentParserInput,
    _limits: DocumentParserLimits,
    signal: AbortSignal,
    budget: ParseResourceBudget,
  ): Promise<FormatParseOutput> {
    throwIfAborted(signal);
    const decoded = decodeTextWithFacts(input.bytes);
    const text = decoded.text;
    // split/map 会分配段落数组，因此先用全文字符数拦截明显超限输入。
    budget.consumeOutputCharacters(text.length);
    const blocks = splitTextParagraphs(text).map((paragraph, index) => ({
      ...createBlock('PARAGRAPH', paragraph.originalText, {
        metadata: {
          extractionSource: 'NATIVE',
          paragraphIndex: index,
          paragraphPolicy: 'BLANK_LINE_V1',
          lineStart: paragraph.lineStart,
          lineEnd: paragraph.lineEnd,
          encoding: decoded.encoding,
        },
      }),
      // 检索文本统一使用 LF；originalText 继续保存文件内部真实 CRLF/LF/CR。
      text: paragraph.lines.join('\n'),
    }));
    return {
      blocks,
      pages: [],
      ocrCandidates: [],
      inspection: { ...emptyInspection(), tableCellCount: 0 },
      warnings: decoded.newlineStyles.length > 1 ? ['TEXT_MIXED_NEWLINE_STYLES'] : [],
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
    budget: ParseResourceBudget,
  ): Promise<FormatParseOutput> {
    throwIfAborted(signal);
    const decoded = decodeTextWithFacts(input.bytes);
    const dialect = detectCsvDelimiter(decoded.text);
    let records: unknown[][];
    try {
      let rowCount = 0;
      records = parseCsv(decoded.text, {
        bom: true,
        delimiter: dialect.delimiter,
        relaxColumnCount: true,
        skipEmptyLines: false,
        maxRecordSize: Math.min(limits.maxXmlEntryBytes, 16 * 1024 * 1024),
        onRecord: (record: string[]) => {
          throwIfAborted(signal);
          rowCount += 1;
          // 在 csv-parse 把记录加入最终 records 数组之前检查，避免完整数据集物化后才失败。
          budget.assertTableShape(rowCount, record.length);
          // 此刻只知道真实列数，矩形补齐数量要等读完最大列宽后再累计。
          budget.consumeTableCells(record.length, 0);
          return record;
        },
      }) as unknown[][];
    } catch (error) {
      if (error instanceof DocumentParserError) throw error;
      throw new DocumentParserError('CSV_CONTENT_INVALID', 'CSV 内容损坏或单条记录超过安全上限', {
        cause: error,
      });
    }
    const sourceRowWidths = records.map((record) => record.length);
    const maximumColumnCount = Math.max(0, ...sourceRowWidths);
    const expandedCellCount = budget.tableArea(records.length, maximumColumnCount);
    budget.consumeTableCells(0, expandedCellCount);
    const rows = records.map((record) => {
      budget.checkpoint();
      const row = record.map(stringifyCsvValue);
      while (row.length < maximumColumnCount) row.push('');
      budget.consumeOutputCharacters(
        row.reduce((characters, value) => characters + value.length, 0) +
          Math.max(0, row.length - 1) * 3,
      );
      return row;
    });
    const cellCount = budget.facts().actualTableCells;
    const header = inferCsvHeader(rows);
    const irregularRowCount = sourceRowWidths.filter(
      (width) => width !== maximumColumnCount,
    ).length;
    const emptyRecordCount = records.filter((record) =>
      record.every((value) => stringifyCsvValue(value).length === 0),
    ).length;
    const warnings = [
      ...(dialect.ambiguous ? ['CSV_DELIMITER_AMBIGUOUS'] : []),
      ...(irregularRowCount > 0 ? ['CSV_IRREGULAR_COLUMN_COUNT'] : []),
      ...(rows.length > 0 && header.headerRowCount === 0 ? ['CSV_HEADER_NOT_CONFIDENT'] : []),
      ...(decoded.newlineStyles.length > 1 ? ['CSV_MIXED_NEWLINE_STYLES'] : []),
    ];
    const blocks =
      rows.length === 0
        ? []
        : [
            createBlock('TABLE', rows.map((row) => row.join(' | ')).join('\n'), {
              table: { rows, headerRowCount: header.headerRowCount, mergedCells: [] },
              metadata: {
                extractionSource: 'NATIVE',
                delimiter: dialect.delimiter,
                delimiterDetectionRevision: 'csv-delimiter-v1',
                delimiterConfidence: dialect.confidence,
                headerDetectionRevision: 'csv-header-v1',
                headerConfidence: header.confidence,
                headerReasons: header.reasons,
                sourceRowWidths,
                irregularRowCount,
                emptyRecordCount,
                encoding: decoded.encoding,
              },
            }),
          ];
    return {
      blocks,
      pages: [],
      ocrCandidates: [],
      inspection: { ...emptyInspection(), tableCellCount: cellCount },
      warnings,
    };
  }
}

/** 支持 UTF-8 BOM、UTF-16LE 和 UTF-16BE；无 BOM 时按 UTF-8 严格解码。 */
export function decodeText(bytes: Uint8Array): string {
  return decodeTextWithFacts(bytes).text;
}

/** 文本解码同时返回编码和换行事实，供 TXT/CSV 写入可审计 metadata。 */
function decodeTextWithFacts(bytes: Uint8Array): DecodedText {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text: string;
  let encoding: DecodedText['encoding'];
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = decodeUtf16(buffer.subarray(2), false);
    encoding = 'UTF-16LE';
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    text = decodeUtf16(buffer.subarray(2), true);
    encoding = 'UTF-16BE';
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');
      encoding =
        buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 'UTF-8-BOM' : 'UTF-8';
    } catch (error) {
      throw new DocumentParserError(
        'TEXT_ENCODING_UNSUPPORTED',
        '文本编码不是受支持的 UTF-8/UTF-16',
        { cause: error },
      );
    }
  }
  // UTF-8 中的 NUL 经常意味着“无 BOM UTF-16”或误传二进制；继续解析会生成隐蔽脏文本。
  if (text.includes('\0')) {
    throw new DocumentParserError('TEXT_BINARY_CONTENT_UNSUPPORTED', '文本中包含 NUL 二进制字节');
  }
  return { text, encoding, newlineStyles: collectNewlineStyles(text) };
}

/** 严格解码 UTF-16；奇数字节和未配对代理项都不能被替换字符悄悄吞掉。 */
function decodeUtf16(bytes: Uint8Array, bigEndian: boolean): string {
  if (bytes.byteLength % 2 !== 0) {
    throw new DocumentParserError('TEXT_ENCODING_INVALID_UTF16', 'UTF-16 正文字节数必须为偶数');
  }
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const normalized = bigEndian ? Buffer.allocUnsafe(source.byteLength) : source;
  if (bigEndian) {
    for (let index = 0; index < source.byteLength; index += 2) {
      normalized[index] = source[index + 1] ?? 0;
      normalized[index + 1] = source[index] ?? 0;
    }
  }
  try {
    return new TextDecoder('utf-16le', { fatal: true }).decode(normalized);
  } catch (error) {
    throw new DocumentParserError('TEXT_ENCODING_INVALID_UTF16', 'UTF-16 包含未配对代理项', {
      cause: error,
    });
  }
}

/** 解码事实只包含低基数枚举，不保存正文。 */
interface DecodedText {
  readonly text: string;
  readonly encoding: 'UTF-8' | 'UTF-8-BOM' | 'UTF-16LE' | 'UTF-16BE';
  readonly newlineStyles: readonly ('CRLF' | 'LF' | 'CR')[];
}

/** 纯文本段落同时保留原始分隔符和统一检索行。 */
interface TextParagraph {
  readonly originalText: string;
  readonly lines: readonly string[];
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** 按 CRLF/LF/CR 三种边界切行；只把空白行作为段落分隔，不按单换行误切段。 */
function splitTextParagraphs(text: string): readonly TextParagraph[] {
  const lines: { readonly content: string; readonly separator: string }[] = [];
  const newline = /\r\n|\n|\r/gu;
  let start = 0;
  for (const match of text.matchAll(newline)) {
    lines.push({ content: text.slice(start, match.index), separator: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ content: text.slice(start), separator: '' });

  const paragraphs: TextParagraph[] = [];
  let paragraphStart = -1;
  for (let lineIndex = 0; lineIndex <= lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const boundary = line === undefined || line.content.trim().length === 0;
    if (!boundary && paragraphStart < 0) paragraphStart = lineIndex;
    if (!boundary || paragraphStart < 0) continue;
    const paragraphLines = lines.slice(paragraphStart, lineIndex);
    paragraphs.push({
      originalText: paragraphLines
        .map(
          (item, index) => item.content + (index + 1 < paragraphLines.length ? item.separator : ''),
        )
        .join(''),
      lines: paragraphLines.map((item) => item.content),
      lineStart: paragraphStart + 1,
      lineEnd: lineIndex,
    });
    paragraphStart = -1;
  }
  return paragraphs;
}

/** 返回文件实际使用的换行类型，顺序固定，避免 warning/metadata 随扫描顺序漂移。 */
function collectNewlineStyles(text: string): DecodedText['newlineStyles'] {
  return [
    ...(text.includes('\r\n') ? (['CRLF'] as const) : []),
    ...(/(^|[^\r])\n/u.test(text) ? (['LF'] as const) : []),
    /\r(?!\n)/u.test(text) ? 'CR' : null,
  ].filter((style): style is 'CRLF' | 'LF' | 'CR' => style !== null);
}

/** CSV 方言判定结果；歧义必须通过 warning 暴露，不能悄悄改变列结构。 */
interface CsvDialect {
  readonly delimiter: ',' | ';' | '\t' | '|';
  readonly confidence: number;
  readonly ambiguous: boolean;
}

/**
 * 只扫描引号外字符判分隔符，不提前物化四份 CSV。
 * 排名依次看“各记录列数一致”“实际出现于多少记录”“总出现次数”，完全相同则按稳定优先级选择并告警。
 */
function detectCsvDelimiter(text: string): CsvDialect {
  const candidates = [',', ';', '\t', '|'] as const;
  const records: number[][] = [];
  let counts = candidates.map(() => 0);
  let inQuotes = false;
  let hasContent = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (character === '"') {
      hasContent = true;
      if (inQuotes && text[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (character === '\r' || character === '\n')) {
      if (hasContent) records.push(counts);
      counts = candidates.map(() => 0);
      hasContent = false;
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      continue;
    }
    if (character.trim().length > 0) hasContent = true;
    if (!inQuotes) {
      const candidateIndex = candidates.indexOf(character as (typeof candidates)[number]);
      if (candidateIndex >= 0) counts[candidateIndex] = (counts[candidateIndex] ?? 0) + 1;
    }
  }
  if (hasContent) records.push(counts);

  const ranks = candidates.map((delimiter, candidateIndex) => {
    const delimiterCounts = records.map((record) => record[candidateIndex] ?? 0);
    const positiveRecordCount = delimiterCounts.filter((count) => count > 0).length;
    const frequencies = new Map<number, number>();
    for (const count of delimiterCounts) frequencies.set(count, (frequencies.get(count) ?? 0) + 1);
    const consistentRecordCount = Math.max(0, ...frequencies.values());
    const totalCount = delimiterCounts.reduce((sum, count) => sum + count, 0);
    return { delimiter, rank: [consistentRecordCount, positiveRecordCount, totalCount] as const };
  });
  const useful = ranks.filter((item) => item.rank[2] > 0);
  if (useful.length === 0) return { delimiter: ',', confidence: 1, ambiguous: false };
  useful.sort((left, right) => compareRank(right.rank, left.rank));
  const best = useful[0] as (typeof useful)[number];
  const second = useful[1];
  const ambiguous = second !== undefined && compareRank(best.rank, second.rank) === 0;
  const denominator = Math.max(1, records.length);
  return {
    delimiter: best.delimiter,
    confidence: Number((best.rank[1] / denominator).toFixed(3)),
    ambiguous,
  };
}

/** 对三个整数事实做稳定字典序比较。 */
function compareRank(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** 表头只在首行文本、唯一且至少一个数据列呈稳定非文本类型时成立。 */
function inferCsvHeader(rows: readonly (readonly string[])[]): {
  readonly headerRowCount: 0 | 1;
  readonly confidence: number;
  readonly reasons: readonly string[];
} {
  const first = rows[0];
  if (!first || rows.length < 2 || first.length === 0) {
    return { headerRowCount: 0, confidence: 0, reasons: ['INSUFFICIENT_ROWS'] };
  }
  const normalized = first.map((value) => value.trim().toLocaleLowerCase());
  const nonEmptyUnique =
    normalized.every((value) => value.length > 0) && new Set(normalized).size === normalized.length;
  const firstAllText = first.every((value) => classifyCsvValue(value) === 'TEXT');
  let typedEvidenceColumns = 0;
  for (let column = 0; column < first.length; column += 1) {
    const laterKinds = rows
      .slice(1)
      .map((row) => classifyCsvValue(row[column] ?? ''))
      .filter((kind) => kind !== 'EMPTY');
    if (
      laterKinds.length > 0 &&
      laterKinds.filter((kind) => kind !== 'TEXT').length > laterKinds.length / 2
    ) {
      typedEvidenceColumns += 1;
    }
  }
  const headerRowCount = nonEmptyUnique && firstAllText && typedEvidenceColumns > 0 ? 1 : 0;
  const confidence =
    headerRowCount === 1 ? Math.min(0.99, 0.75 + typedEvidenceColumns * 0.08) : 0.4;
  return {
    headerRowCount,
    confidence,
    reasons: [
      nonEmptyUnique ? 'FIRST_ROW_NON_EMPTY_UNIQUE' : 'FIRST_ROW_NOT_UNIQUE',
      firstAllText ? 'FIRST_ROW_ALL_TEXT' : 'FIRST_ROW_MIXED_TYPES',
      `TYPED_DATA_COLUMNS_${typedEvidenceColumns}`,
    ],
  };
}

/** 只使用确定性基础类型做表头证据，不猜测地区化日期或业务编号。 */
function classifyCsvValue(value: string): 'EMPTY' | 'NUMBER' | 'BOOLEAN' | 'TEXT' {
  const normalized = value.trim();
  if (normalized.length === 0) return 'EMPTY';
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(normalized)) return 'NUMBER';
  if (/^(?:true|false)$/iu.test(normalized)) return 'BOOLEAN';
  return 'TEXT';
}

/** CSV 库可能返回 Buffer/Date 等值，统一为可序列化字符串。 */
function stringifyCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}
