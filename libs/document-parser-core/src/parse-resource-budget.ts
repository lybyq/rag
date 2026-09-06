/**
 * 九类 Node Parser 共用的单次解析资源预算账本。
 *
 * 它在循环、数组扩容和合并单元格占位展开之前检查计数，避免“解析完才发现超限”。
 * 这里只管理确定性计数与取消，不解析任何格式，也不负责 HTTP、日志或进程调度。
 *
 * @requirement PAR-017
 */
import type { ParsedBlockCandidate } from '@rag/contracts';
import { DocumentParserError, throwIfAborted, type DocumentParserLimits } from './types';

/** 可写入 Parser inspection/指标的低基数预算事实。 */
export interface ParserBudgetFacts {
  readonly actualTableCells: number;
  readonly expandedTableCells: number;
  readonly maximumTableRows: number;
  readonly maximumTableColumns: number;
  readonly maximumTableSpan: number;
  readonly totalPixels: number;
  readonly outputCharacters: number;
}

/**
 * 单次解析的有界计数器。
 * 所有加法和乘法都先验证安全整数，防止 JavaScript Number 溢出后绕过上限。
 */
export class ParseResourceBudget {
  private actualTableCells = 0;
  private expandedTableCells = 0;
  private maximumTableRows = 0;
  private maximumTableColumns = 0;
  private maximumTableSpan = 1;
  private totalPixels = 0;
  private outputCharacters = 0;

  public constructor(
    private readonly limits: DocumentParserLimits,
    private readonly signal: AbortSignal,
  ) {}

  /** 在每个可控循环边界传播取消。 */
  public checkpoint(): void {
    throwIfAborted(this.signal);
  }

  /**
   * 在表格行/列数组扩容前检查当前形状。
   * 行列限制针对单张表，累计单元格限制由 consumeTableCells 负责。
   */
  public assertTableShape(rowCount: number, columnCount: number): void {
    this.checkpoint();
    assertNonNegativeSafeInteger(rowCount, 'TABLE_ROW_LIMIT_EXCEEDED');
    assertNonNegativeSafeInteger(columnCount, 'TABLE_COLUMN_LIMIT_EXCEEDED');
    if (rowCount > this.maximumAllowedRows()) {
      throw limitError('TABLE_ROW_LIMIT_EXCEEDED', '表格行数超过 Parser 资源上限');
    }
    if (columnCount > this.maximumAllowedColumns()) {
      throw limitError('TABLE_COLUMN_LIMIT_EXCEEDED', '表格列数超过 Parser 资源上限');
    }
    this.maximumTableRows = Math.max(this.maximumTableRows, rowCount);
    this.maximumTableColumns = Math.max(this.maximumTableColumns, columnCount);
  }

  /**
   * 在补齐矩形表格前安全计算行×列面积。
   * 该方法只计算和校验形状，不累计；调用方随后用 consumeTableCells 写入真实数量。
   */
  public tableArea(rowCount: number, columnCount: number): number {
    this.assertTableShape(rowCount, columnCount);
    if (rowCount === 0 || columnCount === 0) return 0;
    if (rowCount > Math.floor(Number.MAX_SAFE_INTEGER / columnCount)) {
      throw limitError('TABLE_EXPANDED_CELL_LIMIT_EXCEEDED', '表格展开面积超出安全整数范围');
    }
    return rowCount * columnCount;
  }

  /** 校验单个合并跨度，并返回经过安全整数检查的展开面积。 */
  public assertTableSpan(rowSpan: number, columnSpan: number): number {
    assertPositiveSafeInteger(rowSpan, 'TABLE_SPAN_LIMIT_EXCEEDED');
    assertPositiveSafeInteger(columnSpan, 'TABLE_SPAN_LIMIT_EXCEEDED');
    const maximumSpan = this.maximumAllowedSpan();
    if (rowSpan > maximumSpan || columnSpan > maximumSpan) {
      throw limitError('TABLE_SPAN_LIMIT_EXCEEDED', '表格合并跨度超过 Parser 资源上限');
    }
    if (rowSpan > Math.floor(Number.MAX_SAFE_INTEGER / columnSpan)) {
      throw limitError('TABLE_SPAN_LIMIT_EXCEEDED', '表格合并跨度乘积超出安全整数范围');
    }
    this.maximumTableSpan = Math.max(this.maximumTableSpan, rowSpan, columnSpan);
    return rowSpan * columnSpan;
  }

  /** 在写入单元格或 occupied 占位前累计真实与展开数量。 */
  public consumeTableCells(actualCells: number, expandedCells: number): void {
    this.checkpoint();
    this.actualTableCells = checkedAddition(
      this.actualTableCells,
      actualCells,
      this.limits.maxTableCells,
      'TABLE_CELL_LIMIT_EXCEEDED',
      '表格实际单元格数量超过 Parser 资源上限',
    );
    this.expandedTableCells = checkedAddition(
      this.expandedTableCells,
      expandedCells,
      this.maximumAllowedExpandedCells(),
      'TABLE_EXPANDED_CELL_LIMIT_EXCEEDED',
      '表格展开后单元格数量超过 Parser 资源上限',
    );
  }

  /** 在构造大字符串前累计预计输出字符。 */
  public consumeOutputCharacters(characters: number): void {
    this.checkpoint();
    this.outputCharacters = checkedAddition(
      this.outputCharacters,
      characters,
      this.maximumAllowedOutputCharacters(),
      'PARSER_OUTPUT_LIMIT_EXCEEDED',
      'Parser 输出字符数量超过资源上限',
    );
  }

  /** 在图片解码或累计媒体事实前检查宽高乘积与总像素。 */
  public consumePixels(width: number, height: number): void {
    this.checkpoint();
    assertPositiveSafeInteger(width, 'PIXEL_LIMIT_EXCEEDED');
    assertPositiveSafeInteger(height, 'PIXEL_LIMIT_EXCEEDED');
    if (width > Math.floor(Number.MAX_SAFE_INTEGER / height)) {
      throw limitError('PIXEL_LIMIT_EXCEEDED', '图片像素乘积超出安全整数范围');
    }
    this.totalPixels = checkedAddition(
      this.totalPixels,
      width * height,
      this.limits.maxTotalPixels,
      'PIXEL_LIMIT_EXCEEDED',
      '图片累计像素数量超过 Parser 资源上限',
    );
  }

  /**
   * Registry 在最终 Zod 校验前重新按真实 Block 核对输出规模。
   * 这是第三方库已经物化内容时的兜底，不会与过程计数相加。
   */
  public verifyFinalOutput(blocks: readonly ParsedBlockCandidate[]): void {
    let characters = 0;
    for (const block of blocks) {
      this.checkpoint();
      characters = checkedAddition(
        characters,
        block.originalText.length,
        this.maximumAllowedOutputCharacters(),
        'PARSER_OUTPUT_LIMIT_EXCEEDED',
        'Parser 输出字符数量超过资源上限',
      );
    }
    this.outputCharacters = Math.max(this.outputCharacters, characters);
  }

  /** 返回只含数值的快照，不暴露文件名或正文。 */
  public facts(): ParserBudgetFacts {
    return {
      actualTableCells: this.actualTableCells,
      expandedTableCells: this.expandedTableCells,
      maximumTableRows: this.maximumTableRows,
      maximumTableColumns: this.maximumTableColumns,
      maximumTableSpan: this.maximumTableSpan,
      totalPixels: this.totalPixels,
      outputCharacters: this.outputCharacters,
    };
  }

  private maximumAllowedExpandedCells(): number {
    return this.limits.maxExpandedTableCells ?? this.limits.maxTableCells;
  }

  private maximumAllowedRows(): number {
    return this.limits.maxTableRows ?? this.limits.maxTableCells;
  }

  private maximumAllowedColumns(): number {
    return this.limits.maxTableColumns ?? Math.min(this.limits.maxTableCells, 100_000);
  }

  private maximumAllowedSpan(): number {
    return this.limits.maxTableSpan ?? Math.min(this.maximumAllowedExpandedCells(), 10_000);
  }

  private maximumAllowedOutputCharacters(): number {
    const configured = this.limits.maxOutputCharacters;
    if (configured !== undefined) return configured;
    const derived = this.limits.maxInputBytes * 8;
    return Number.isSafeInteger(derived) ? derived : Number.MAX_SAFE_INTEGER;
  }
}

/** 安全累计计数；任何非安全整数都按超限处理，不能让 Infinity/NaN 绕过比较。 */
function checkedAddition(
  current: number,
  delta: number,
  maximum: number,
  code: string,
  message: string,
): number {
  assertNonNegativeSafeInteger(delta, code);
  if (!Number.isSafeInteger(current + delta) || current + delta > maximum) {
    throw limitError(code, message);
  }
  return current + delta;
}

/** 断言计数是非负安全整数。 */
function assertNonNegativeSafeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw limitError(code, 'Parser 资源计数无效');
}

/** 断言跨度是正安全整数。 */
function assertPositiveSafeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw limitError(code, '表格合并跨度无效');
}

/** 统一构造确定性的文档资源超限错误。 */
function limitError(code: string, message: string): DocumentParserError {
  return new DocumentParserError(code, message, { failureClass: 'DOCUMENT_PROBLEM' });
}
