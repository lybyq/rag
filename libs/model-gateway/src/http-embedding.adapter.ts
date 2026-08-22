/**
 * M05 企业内网 HTTP Embedding 契约 Adapter。
 *
 * 统一协议：GET `/health`、GET `/metadata`、POST `/v1/embeddings`。
 * POST 请求显式携带 QUERY/DOCUMENT purpose；响应逐项返回 output/failure，便于部分失败重试。
 * 本文件负责超时、取消、状态码分类和 Zod 校验，不把 Endpoint、API Key 或正文写入错误。
 *
 * @requirement IDX-001
 * @requirement IDX-003
 * @requirement IDX-004
 * @requirement CFG-005
 * @requirement CFG-006
 */
import type { EmbeddingPort, ProviderCallOptions } from '@rag/application';
import type { AppConfig } from '@rag/config';
import {
  EmbeddingBatchResponseSchema,
  EmbeddingProviderMetadataSchema,
  type EmbeddingBatchResponse,
  type EmbeddingInput,
  type EmbeddingItemFailure,
  type EmbeddingProviderMetadata,
  type EmbeddingPurpose,
} from '@rag/contracts';

interface HttpEmbeddingAdapterConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly modelId: string;
  readonly protocolVersion: string;
  readonly maxResponseBytes: number;
}

/** 内网自有协议 HTTP Adapter；也允许契约测试注入 fetch。 */
export class HttpEmbeddingAdapter implements EmbeddingPort {
  private readonly config: HttpEmbeddingAdapterConfig;

  public constructor(
    config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.config = {
      baseUrl: ensureTrailingSlash(config.embedding.baseUrl),
      ...(config.embedding.apiKey ? { apiKey: config.embedding.apiKey } : {}),
      modelId: config.embedding.modelId,
      protocolVersion: config.embedding.protocolVersion,
      maxResponseBytes: 64 * 1024 * 1024,
    };
  }

  /** 健康端点只接受 2xx；响应正文不是必须，避免厂商健康格式耦合。 */
  public async checkHealth(options: ProviderCallOptions): Promise<void> {
    const response = await this.request('health', { method: 'GET' }, options);
    if (!response.ok) throw new Error(`Embedding 健康检查失败：HTTP ${response.status}`);
  }

  /** metadata 必须是实际服务返回值，不能从本地配置伪造。 */
  public async getMetadata(options: ProviderCallOptions): Promise<EmbeddingProviderMetadata> {
    const response = await this.request('metadata', { method: 'GET' }, options);
    if (!response.ok) throw new Error(`Embedding metadata 失败：HTTP ${response.status}`);
    return EmbeddingProviderMetadataSchema.parse(
      await readBoundedJson(response, this.config.maxResponseBytes),
    );
  }

  /** 文档向量端点；模板由服务端按 Profile revision 固定。 */
  public embedDocuments(
    inputs: readonly EmbeddingInput[],
    options: ProviderCallOptions,
  ): Promise<EmbeddingBatchResponse> {
    return this.embed('DOCUMENT', inputs, options);
  }

  /** 查询向量端点；与文档模板区分，供 M07 复用。 */
  public embedQueries(
    inputs: readonly EmbeddingInput[],
    options: ProviderCallOptions,
  ): Promise<EmbeddingBatchResponse> {
    return this.embed('QUERY', inputs, options);
  }

  private async embed(
    purpose: EmbeddingPurpose,
    inputs: readonly EmbeddingInput[],
    options: ProviderCallOptions,
  ): Promise<EmbeddingBatchResponse> {
    let response: Response;
    try {
      response = await this.request(
        'v1/embeddings',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: this.config.protocolVersion,
            modelId: this.config.modelId,
            purpose,
            inputs: inputs.map((input) => ({
              itemId: input.itemId,
              contentSha256: input.contentSha256,
              text: input.text,
            })),
          }),
        },
        options,
      );
    } catch {
      if (options.signal.aborted) throw options.signal.reason;
      return allFailed(inputs, 'TIMEOUT', true, 'Embedding 请求超时或网络不可达');
    }
    if (response.status === 429)
      return allFailed(inputs, 'RATE_LIMITED', true, 'Embedding 服务限流');
    if (response.status >= 500)
      return allFailed(inputs, 'UPSTREAM_5XX', true, 'Embedding 服务暂时不可用');
    if (!response.ok) return allFailed(inputs, 'INVALID_INPUT', false, 'Embedding 请求被服务拒绝');
    try {
      return EmbeddingBatchResponseSchema.parse(
        await readBoundedJson(response, this.config.maxResponseBytes),
      );
    } catch {
      return allFailed(inputs, 'SCHEMA_ERROR', false, 'Embedding 响应 Schema 不兼容');
    }
  }

  private request(
    path: string,
    init: RequestInit,
    options: ProviderCallOptions,
  ): Promise<Response> {
    const remainingMs = options.deadlineAt.getTime() - Date.now();
    if (remainingMs <= 0) return Promise.reject(new Error('Embedding Deadline 已到期'));
    const timeoutSignal = AbortSignal.timeout(
      Math.max(1, Math.min(options.timeoutMs, remainingMs)),
    );
    return this.fetchImpl(new URL(path, this.config.baseUrl), {
      ...init,
      headers: {
        accept: 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...init.headers,
      },
      redirect: 'error',
      signal: AbortSignal.any([options.signal, timeoutSignal]),
    });
  }
}

function allFailed(
  inputs: readonly EmbeddingInput[],
  code: EmbeddingItemFailure['code'],
  retryable: boolean,
  publicMessage: string,
): EmbeddingBatchResponse {
  return {
    outputs: [],
    failures: inputs.map((input) => ({ itemId: input.itemId, code, retryable, publicMessage })),
  };
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maximumBytes) throw new Error('Embedding 响应超过大小上限');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error('Embedding 响应超过大小上限');
  return JSON.parse(new TextDecoder().decode(bytes));
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
