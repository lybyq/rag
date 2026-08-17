/** 内网标准 OCR HTTP Adapter：只提交明确页码并校验响应没有越权返回其他页。 */
import type { OcrPort, ProviderDocumentSource } from '@rag/application';
import type { OcrResult, ProcessingProviderProfile } from '@rag/contracts';
import { OcrResultSchema } from '@rag/contracts';
import type { FetchImplementation, ProviderHttpClientConfig } from './http-json.client';
import { postProviderJson } from './http-json.client';
import { ProcessingProviderError } from './provider.error';

export interface HttpOcrConfig extends ProviderHttpClientConfig {
  readonly profileId: string;
  readonly revision: string;
  readonly protocolVersion: string;
}

export class HttpOcrAdapter implements OcrPort {
  public constructor(
    private readonly config: HttpOcrConfig,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public profile(): ProcessingProviderProfile {
    return {
      kind: 'OCR',
      adapter: 'http',
      profileId: this.config.profileId,
      revision: this.config.revision,
      protocolVersion: this.config.protocolVersion,
      endpoint: this.config.baseUrl,
      capabilities: ['PAGE_SELECTIVE', 'BBOX', 'CONFIDENCE'],
      timeoutMs: this.config.timeoutMs,
    };
  }

  public async recognize(
    source: ProviderDocumentSource,
    pageNumbers: readonly number[],
    signal: AbortSignal,
  ): Promise<OcrResult> {
    const raw = await postProviderJson(
      this.config,
      'v1/ocr',
      { protocolVersion: this.config.protocolVersion, source, pageNumbers },
      signal,
      this.fetchImplementation,
    );
    const parsed = OcrResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'OCR_SCHEMA_MISMATCH',
        'OCR 响应不符合平台契约',
        { cause: parsed.error },
      );
    }
    if (parsed.data.protocolVersion !== this.config.protocolVersion) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'OCR_PROTOCOL_VERSION_MISMATCH',
        'OCR 协议版本与配置不一致',
      );
    }
    if (parsed.data.engineRevision !== this.config.revision) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'OCR_REVISION_MISMATCH',
        'OCR 实际修订与配置 Profile 不一致',
      );
    }
    const requested = new Set(pageNumbers);
    if (parsed.data.pages.some((page) => !requested.has(page.pageNo))) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'OCR_UNREQUESTED_PAGE',
        'OCR 返回了调用方未请求的页面',
      );
    }
    return parsed.data;
  }
}
