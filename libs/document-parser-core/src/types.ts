/**
 * Node Parser Core 的内部端口与错误类型。
 * 独立 Parser App 只负责下载和 HTTP 映射；格式算法只依赖这里的内存输入与公开契约。
 * 本层不依赖 NestJS、MinIO、数据库或 OCR 厂商 SDK。
 *
 * @requirement PAR-004
 * @requirement PAR-005
 * @requirement PAR-006
 * @requirement PAR-013
 */
import type {
  FileStructureInspection,
  OcrTarget,
  ParsedBlockCandidate,
  ParsedPage,
  SupportedFileFormat,
} from '@rag/contracts';

/** 单次解析已完成限流下载后的可信输入。 */
export interface DocumentParserInput {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly format: SupportedFileFormat;
  readonly declaredMime: string;
}

/** 所有格式 Parser 必须返回的统一中间结果。 */
export interface FormatParseOutput {
  readonly blocks: readonly ParsedBlockCandidate[];
  readonly pages: readonly ParsedPage[];
  readonly ocrCandidates: readonly OcrTarget[];
  readonly inspection: FileStructureInspection;
  readonly warnings: readonly string[];
}

/** 结构安全和资源上限由部署配置冻结，并随 Parser Profile 一起发布。 */
export interface DocumentParserLimits {
  readonly maxArchiveDepth: number;
  readonly maxCompressionRatio: number;
  readonly maxPages: number;
  readonly maxTotalPixels: number;
  readonly maxTableCells: number;
  readonly maxInputBytes: number;
  readonly maxArchiveEntries: number;
  readonly maxXmlEntryBytes: number;
}

/** 格式 Parser 的最小内部端口；Registry 负责路由、计时和最终 Zod 校验。 */
export interface DocumentFormatParser {
  readonly format: SupportedFileFormat;
  parse(
    input: DocumentParserInput,
    limits: DocumentParserLimits,
    signal: AbortSignal,
  ): Promise<FormatParseOutput>;
}

/** 可公开给调用方的稳定 Parser 错误。 */
export class DocumentParserError extends Error {
  public readonly failureClass: 'DOCUMENT_PROBLEM' | 'DEVELOPER_DEFECT' | 'RETRYABLE_PROVIDER';
  public readonly httpStatus: number;
  public readonly retryable: boolean;

  public constructor(
    public readonly code: string,
    message: string,
    options: {
      readonly failureClass?: 'DOCUMENT_PROBLEM' | 'DEVELOPER_DEFECT' | 'RETRYABLE_PROVIDER';
      readonly httpStatus?: number;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DocumentParserError';
    this.failureClass = options.failureClass ?? 'DOCUMENT_PROBLEM';
    this.httpStatus = options.httpStatus ?? 422;
    this.retryable = options.retryable ?? false;
  }
}

/** 为不适用的格式字段创建明确的 null，而不是使用误导性的 0。 */
export function emptyInspection(): FileStructureInspection {
  return {
    encrypted: false,
    hasMacros: false,
    embeddedObjectCount: 0,
    externalLinkCount: 0,
    archiveDepth: null,
    compressedSizeBytes: null,
    uncompressedSizeBytes: null,
    pageCount: null,
    totalPixels: null,
    tableCellCount: null,
  };
}

/** 构造普通 Block，集中补齐统一契约中的定位空值。 */
export function createBlock(
  type: ParsedBlockCandidate['type'],
  originalText: string,
  overrides: Partial<Omit<ParsedBlockCandidate, 'type' | 'text' | 'originalText'>> = {},
): ParsedBlockCandidate {
  return {
    type,
    text: originalText,
    originalText,
    pageNo: null,
    sheetName: null,
    slideNo: null,
    bbox: null,
    headingLevel: null,
    confidence: null,
    table: null,
    metadata: { extractionSource: 'NATIVE' },
    ...overrides,
  };
}

/** 把任意数值限制到归一化坐标范围，过滤浮点舍入误差。 */
export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/** 在长循环和每页/每 Sheet 边界传播调用方取消。 */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DocumentParserError('PARSER_ABORTED', '解析任务已取消', {
          failureClass: 'RETRYABLE_PROVIDER',
          httpStatus: 499,
          retryable: true,
        });
  }
}
