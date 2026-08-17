/** 内网标准 Parser HTTP Adapter：响应必须完整匹配版本化 ParserResult 契约。 */
import type { ParserPort, ProviderDocumentSource } from '@rag/application';
import type { ParserResult, ProcessingProviderProfile } from '@rag/contracts';
import { ParserResultSchema } from '@rag/contracts';
import type { FetchImplementation, ProviderHttpClientConfig } from './http-json.client';
import { postProviderJson } from './http-json.client';
import { ProcessingProviderError } from './provider.error';

export interface HttpParserConfig extends ProviderHttpClientConfig {
  readonly profileId: string;
  readonly revision: string;
  readonly protocolVersion: string;
}

export class HttpParserAdapter implements ParserPort {
  public constructor(
    private readonly config: HttpParserConfig,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public profile(): ProcessingProviderProfile {
    return {
      kind: 'PARSER',
      adapter: 'http',
      profileId: this.config.profileId,
      revision: this.config.revision,
      protocolVersion: this.config.protocolVersion,
      endpoint: this.config.baseUrl,
      capabilities: ['PDF', 'DOCX', 'XLSX', 'PPTX', 'IMAGE', 'HTML', 'MARKDOWN', 'TEXT', 'CSV'],
      timeoutMs: this.config.timeoutMs,
    };
  }

  public async parse(source: ProviderDocumentSource, signal: AbortSignal): Promise<ParserResult> {
    const raw = await postProviderJson(
      this.config,
      'v1/parse',
      { protocolVersion: this.config.protocolVersion, source },
      signal,
      this.fetchImplementation,
    );
    const parsed = ParserResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'PARSER_SCHEMA_MISMATCH',
        'Parser 响应不符合平台契约',
        { cause: parsed.error },
      );
    }
    if (parsed.data.protocolVersion !== this.config.protocolVersion) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'PARSER_PROTOCOL_VERSION_MISMATCH',
        'Parser 协议版本与配置不一致',
      );
    }
    if (parsed.data.parserRevision !== this.config.revision) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'PARSER_REVISION_MISMATCH',
        'Parser 实际修订与配置 Profile 不一致',
      );
    }
    return parsed.data;
  }
}
