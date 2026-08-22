/**
 * 多格式 Parser Registry。
 * 它根据已由上游三方校验过的格式选择唯一 Parser，并统一写入协议、修订、耗时与 Zod 契约。
 * Registry 不重新猜测扩展名，也不执行 OCR 或 Chunk。
 *
 * @requirement PAR-005
 * @requirement PAR-006
 * @requirement PAR-009
 * @requirement PAR-013
 */
import { ParserResultSchema, type ParserResult, type SupportedFileFormat } from '@rag/contracts';
import type { DocumentFormatParser, DocumentParserInput, DocumentParserLimits } from './types';
import { DocumentParserError, throwIfAborted } from './types';

/** Registry 发布身份；修改解析语义时必须升级 revision。 */
export interface ParserRegistryIdentity {
  readonly revision: string;
  readonly protocolVersion: string;
}

/** 对格式实现建立封闭、可测试的路由表。 */
export class ParserRegistry {
  private readonly parsers: ReadonlyMap<SupportedFileFormat, DocumentFormatParser>;

  public constructor(
    parsers: readonly DocumentFormatParser[],
    private readonly limits: DocumentParserLimits,
    private readonly identity: ParserRegistryIdentity,
  ) {
    const entries = parsers.map((parser) => [parser.format, parser] as const);
    this.parsers = new Map(entries);
    if (this.parsers.size !== parsers.length) {
      throw new DocumentParserError('PARSER_DUPLICATE_FORMAT', 'Parser Registry 出现重复格式', {
        failureClass: 'DEVELOPER_DEFECT',
        httpStatus: 500,
      });
    }
  }

  /** 路由并校验一次解析；任何格式实现都无法绕过最终 ParserResult Schema。 */
  public async parse(input: DocumentParserInput, signal: AbortSignal): Promise<ParserResult> {
    const startedAt = Date.now();
    throwIfAborted(signal);
    if (input.bytes.byteLength > this.limits.maxInputBytes) {
      throw new DocumentParserError('PARSER_INPUT_TOO_LARGE', '文件超过 Parser 输入上限');
    }
    const parser = this.parsers.get(input.format);
    if (!parser) {
      throw new DocumentParserError('PARSER_FORMAT_UNSUPPORTED', 'Parser 未注册该文件格式', {
        failureClass: 'DEVELOPER_DEFECT',
        httpStatus: 500,
      });
    }

    const output = await parser.parse(input, this.limits, signal);
    throwIfAborted(signal);
    const result = ParserResultSchema.safeParse({
      parserName: `RAG Node ${input.format} Parser`,
      parserRevision: this.identity.revision,
      protocolVersion: this.identity.protocolVersion,
      ...output,
      blocks: [...output.blocks],
      pages: [...output.pages],
      ocrCandidates: [...output.ocrCandidates],
      warnings: [...output.warnings],
      durationMs: Date.now() - startedAt,
    });
    if (!result.success) {
      throw new DocumentParserError(
        'PARSER_OUTPUT_SCHEMA_MISMATCH',
        '格式 Parser 输出不符合统一契约',
        {
          failureClass: 'DEVELOPER_DEFECT',
          httpStatus: 500,
          cause: result.error,
        },
      );
    }
    return result.data;
  }

  /** 返回当前二进制真正具备的格式能力，供 readiness/metadata 验证。 */
  public formats(): readonly SupportedFileFormat[] {
    return [...this.parsers.keys()].sort();
  }
}
