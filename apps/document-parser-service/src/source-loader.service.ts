/**
 * Parser Service 的受控源文件下载器。
 * 只允许配置白名单中的 http(s) 主机，拒绝重定向、URL 用户信息和超限响应，并传播 Deadline/取消。
 * 它只返回有限内存字节，不记录包含签名参数的 URL。
 *
 * @requirement PAR-004
 * @requirement PAR-013
 */
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { DocumentParserError } from '@rag/document-parser-core';

/** 独立 Parser 下载源对象的基础设施服务。 */
@Injectable()
export class ParserSourceLoader {
  public constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** 下载预签名源文件；响应未完成前不会把部分字节交给格式 Parser。 */
  public async load(sourceUrl: string, signal: AbortSignal): Promise<Uint8Array> {
    const url = this.validateUrl(sourceUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/octet-stream' },
        signal,
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new DocumentParserError('PARSER_SOURCE_NETWORK_ERROR', 'Parser 无法读取源文件', {
        failureClass: 'RETRYABLE_PROVIDER',
        httpStatus: 503,
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new DocumentParserError(
        `PARSER_SOURCE_HTTP_${response.status}`,
        response.status >= 500 ? '源文件存储暂时不可用' : '源文件下载授权无效或已过期',
        {
          failureClass: response.status >= 500 ? 'RETRYABLE_PROVIDER' : 'DOCUMENT_PROBLEM',
          httpStatus: response.status >= 500 ? 503 : 422,
          retryable: response.status >= 500,
        },
      );
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.config.fileProcessing.parser.maxInputBytes
    ) {
      throw new DocumentParserError('PARSER_INPUT_TOO_LARGE', '文件超过 Parser 输入上限');
    }
    return readResponseWithLimit(response, this.config.fileProcessing.parser.maxInputBytes, signal);
  }

  /** URL 主机采用精确白名单；禁止凭据、非 HTTP 协议和重定向绕过。 */
  private validateUrl(sourceUrl: string): URL {
    let url: URL;
    try {
      url = new URL(sourceUrl);
    } catch {
      // URL 构造异常通常回显完整输入，其中可能含预签名参数；不把它挂到可记录的 cause。
      throw new DocumentParserError('PARSER_SOURCE_URL_INVALID', '源文件 URL 无效');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new DocumentParserError('PARSER_SOURCE_URL_FORBIDDEN', '源文件 URL 协议或凭据不被允许');
    }
    const allowedHosts = new Set(
      this.config.fileProcessing.parser.allowedSourceHosts.map((host) => host.toLowerCase()),
    );
    if (!allowedHosts.has(url.hostname.toLowerCase())) {
      throw new DocumentParserError('PARSER_SOURCE_HOST_FORBIDDEN', '源文件主机不在 Parser 白名单');
    }
    return url;
  }
}

/** 流式读取响应并在越界时主动取消底层 reader。 */
async function readResponseWithLimit(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel(signal.reason);
      throw signal.reason;
    }
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel('parser input too large');
      throw new DocumentParserError('PARSER_INPUT_TOO_LARGE', '文件超过 Parser 输入上限');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
