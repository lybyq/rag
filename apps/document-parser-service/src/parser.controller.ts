/**
 * Node Parser 标准 HTTP 协议入口。
 * Controller 只做 Zod 输入映射、可选共享密钥校验、取消传播和结果返回；格式逻辑全部在 Registry。
 * 响应直接使用 ParserResult，供现有 HttpParserAdapter 执行第二次 Schema/Revision 校验。
 *
 * @requirement PAR-004
 * @requirement PAR-005
 * @requirement PAR-006
 * @requirement PAR-013
 */
import { Body, Controller, Headers, Inject, Post, Req } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { ParserResultSchema, SupportedFileFormatSchema, type ParserResult } from '@rag/contracts';
import { DocumentParserError, type ParserRegistry } from '@rag/document-parser-core';
import { MetricsService } from '@rag/observability';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DOCUMENT_PARSER_REGISTRY } from './tokens';
import { ParserSourceLoader } from './source-loader.service';

/** Parser HTTP 请求唯一允许的字段；未知字段被拒绝，避免协议悄悄漂移。 */
export const ParserHttpRequestSchema = z
  .object({
    protocolVersion: z.string().min(1).max(40),
    source: z
      .object({
        url: z.string().url().max(4_096),
        fileName: z.string().min(1).max(512),
        format: SupportedFileFormatSchema,
        declaredMime: z.string().min(1).max(160),
      })
      .strict(),
  })
  .strict();

/** 标准 `/v1/parse` Controller。 */
@Controller('parse')
export class ParserController {
  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DOCUMENT_PARSER_REGISTRY) private readonly registry: ParserRegistry,
    @Inject(ParserSourceLoader) private readonly sourceLoader: ParserSourceLoader,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  /** 下载并解析一个预签名源对象。 */
  @Post()
  public async parse(
    @Body() rawBody: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request,
  ): Promise<ParserResult> {
    this.assertAuthorized(authorization);
    const body = ParserHttpRequestSchema.safeParse(rawBody);
    if (!body.success) {
      throw new DocumentParserError('PARSER_REQUEST_SCHEMA_INVALID', 'Parser 请求不符合协议', {
        httpStatus: 400,
        cause: body.error,
      });
    }
    if (body.data.protocolVersion !== this.config.fileProcessing.parser.protocolVersion) {
      throw new DocumentParserError(
        'PARSER_PROTOCOL_VERSION_MISMATCH',
        'Parser 请求协议版本不匹配',
        {
          failureClass: 'DEVELOPER_DEFECT',
          httpStatus: 409,
        },
      );
    }

    const startedAt = Date.now();
    const clientAbort = new AbortController();
    const onAborted = (): void => clientAbort.abort(new Error('Parser HTTP client aborted'));
    request.once('aborted', onAborted);
    const deadline = AbortSignal.timeout(this.config.fileProcessing.parser.timeoutMs);
    const signal = AbortSignal.any([clientAbort.signal, deadline]);
    let resultLabel = 'failed';
    try {
      const bytes = await this.sourceLoader.load(body.data.source.url, signal);
      const result = await this.registry.parse({ ...body.data.source, bytes }, signal);
      resultLabel = 'succeeded';
      return ParserResultSchema.parse(result);
    } catch (error) {
      // AbortSignal.timeout 的 reason 是 DOMException，不满足平台公开错误契约。
      // 在 HTTP 边界统一转成可重试 504，调用方才能执行受控重试而不是误判为开发缺陷。
      if (deadline.aborted) {
        throw new DocumentParserError('PARSER_TIMEOUT', 'Parser 超过绝对处理时限', {
          failureClass: 'RETRYABLE_PROVIDER',
          httpStatus: 504,
          retryable: true,
        });
      }
      throw error;
    } finally {
      request.off('aborted', onAborted);
      this.metrics.m03ParserRunsTotal.inc({ format: body.data.source.format, result: resultLabel });
      this.metrics.m03ParserDurationSeconds.observe(
        { format: body.data.source.format, result: resultLabel },
        (Date.now() - startedAt) / 1_000,
      );
    }
  }

  /** 空 API Key 表示由隔离网络保护；配置后必须使用 Bearer 且常量时间比较。 */
  private assertAuthorized(authorization: string | undefined): void {
    const expected = this.config.fileProcessing.parser.apiKey;
    if (!expected) return;
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) {
      throw new DocumentParserError('PARSER_UNAUTHORIZED', 'Parser 调用认证失败', {
        httpStatus: 401,
      });
    }
  }
}
