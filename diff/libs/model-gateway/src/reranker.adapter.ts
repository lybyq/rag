/**
 * 专用 Reranker Fixture/HTTP Adapter。
 *
 * HTTP 协议使用 `/health`、`/v1/metadata` 和 `/v1/rerank`，适合在内网模型服务前增加轻量
 * Gateway。Adapter 强制执行 Deadline、单次超时、取消、有限重试、版本匹配和结果全集校验，
 * 错误不包含 query、正文、Endpoint 或密钥。
 *
 * @requirement ANS-002
 * @requirement CFG-001
 * @requirement CFG-004
 * @requirement CFG-006
 */
import {
  CircuitBreaker,
  executeResilientCall,
  type RemoteFailureKind,
  type ProviderCallOptions,
  type RerankerMetadata,
  type RerankerPort,
  type RerankInput,
} from '@rag/application';
import type { AppConfig } from '@rag/config';
import { RerankResponseSchema, type RerankResponse } from '@rag/contracts';
import { z } from 'zod';

const HealthSchema = z.object({ status: z.enum(['ok', 'ready']) });
const MetadataSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  revision: z.string().min(1),
  protocolVersion: z.string().min(1),
  maximumCandidates: z.number().int().positive(),
  maximumInputTokens: z.number().int().positive(),
});
const InternalRerankSchema = z.object({
  protocolVersion: z.string().min(1),
  modelId: z.string().min(1),
  revision: z.string().min(1),
  // 内网 BGE Gateway 可能返回 probability，也可能返回 raw logit；含义由配置决定。
  scores: z.array(
    z.object({
      candidateId: z.string().min(1).max(180),
      score: z.number().finite(),
      rank: z.number().int().positive(),
    }),
  ),
});

/** 不携带正文的 Reranker 稳定错误。 */
export class RerankerProviderError extends Error {
  public constructor(
    public readonly code:
      | 'TIMEOUT'
      | 'CANCELLED'
      | 'RATE_LIMITED'
      | 'UPSTREAM_5XX'
      | 'AUTHENTICATION'
      | 'SCHEMA_ERROR'
      | 'VERSION_MISMATCH'
      | 'PARTIAL_RESULT'
      | 'NETWORK',
    public readonly retryable: boolean,
  ) {
    super(`Reranker Provider 调用失败：${code}`);
    this.name = 'RerankerProviderError';
  }
}

/** 标准内网 HTTP Reranker Adapter。 */
export class HttpRerankerAdapter implements RerankerPort {
  private readonly circuitBreaker = new CircuitBreaker({
    failureThreshold: 5,
    openDurationMs: 30_000,
  });

  public constructor(
    private readonly config: AppConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async checkHealth(options: ProviderCallOptions): Promise<void> {
    const payload = await this.request('health', { method: 'GET' }, options, false);
    if (!HealthSchema.safeParse(payload).success)
      throw new RerankerProviderError('SCHEMA_ERROR', false);
  }

  public async getMetadata(options: ProviderCallOptions): Promise<RerankerMetadata> {
    const payload = await this.request('v1/metadata', { method: 'GET' }, options, false);
    const parsed = MetadataSchema.safeParse(payload);
    if (!parsed.success) throw new RerankerProviderError('SCHEMA_ERROR', false);
    assertMetadata(this.config, parsed.data);
    return parsed.data;
  }

  public async rerank(input: RerankInput, options: ProviderCallOptions): Promise<RerankResponse> {
    if (input.documents.length > this.config.reranker.maxCandidates) {
      throw new RerankerProviderError('SCHEMA_ERROR', false);
    }
    const payload = await this.request(
      'v1/rerank',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: this.config.reranker.protocolVersion,
          modelId: this.config.reranker.modelId,
          revision: this.config.reranker.revision,
          query: input.query,
          documents: input.documents,
          topN: input.topN,
        }),
      },
      options,
      true,
    );
    const parsed = InternalRerankSchema.safeParse(payload);
    if (!parsed.success) throw new RerankerProviderError('SCHEMA_ERROR', false);
    assertMetadata(this.config, {
      provider: 'http',
      modelId: parsed.data.modelId,
      revision: parsed.data.revision,
      protocolVersion: parsed.data.protocolVersion,
      maximumCandidates: this.config.reranker.maxCandidates,
      maximumInputTokens: this.config.reranker.maxInputTokens,
    });
    const requestedIds = new Set(input.documents.map((document) => document.candidateId));
    const orderedScores = [...parsed.data.scores].sort((left, right) => left.rank - right.rank);
    const returnedIds = orderedScores.map((score) => score.candidateId);
    const returnedRanks = orderedScores.map((score) => score.rank);
    const expectedCount = Math.min(input.topN, input.documents.length);
    if (
      new Set(returnedIds).size !== returnedIds.length ||
      returnedIds.some((candidateId) => !requestedIds.has(candidateId)) ||
      orderedScores.length !== expectedCount ||
      returnedRanks.some((rank, index) => rank !== index + 1)
    ) {
      throw new RerankerProviderError('PARTIAL_RESULT', false);
    }
    const normalizedScores = orderedScores.map((score) => ({
      ...score,
      score: normalizeRerankerScore(score.score, this.config.reranker.scoreType),
    }));
    return RerankResponseSchema.parse({
      modelId: parsed.data.modelId,
      revision: parsed.data.revision,
      scores: normalizedScores,
    });
  }

  private async request(
    path: string,
    init: RequestInit,
    options: ProviderCallOptions,
    retry: boolean,
  ): Promise<unknown> {
    try {
      return await executeResilientCall(
        ({ signal }) => this.invoke(path, init, { ...options, signal }),
        {
          operation: 'reranker',
          deadlineAt: options.deadlineAt,
          singleAttemptTimeoutMs: options.timeoutMs,
          maxAttempts: retry ? 2 : 1,
          retryBaseDelayMs: 100,
          retryMaximumDelayMs: 500,
          signal: options.signal,
          classify: (error) => rerankerFailureKind(classifyRerankerError(error, options.signal)),
          circuitBreaker: this.circuitBreaker,
        },
      );
    } catch (error) {
      throw classifyRerankerError(error, options.signal);
    }
  }

  private async invoke(
    path: string,
    init: RequestInit,
    options: ProviderCallOptions,
  ): Promise<unknown> {
    if (options.signal.aborted) throw new RerankerProviderError('CANCELLED', false);
    const remaining = options.deadlineAt.getTime() - Date.now();
    if (remaining <= 0) throw new RerankerProviderError('TIMEOUT', true);
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(Math.min(options.timeoutMs, remaining)),
    ]);
    const response = await this.fetcher(joinUrl(this.config.reranker.baseUrl, path), {
      ...init,
      headers: {
        ...init.headers,
        ...(this.config.reranker.apiKey
          ? { authorization: `Bearer ${this.config.reranker.apiKey}` }
          : {}),
      },
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new RerankerProviderError('AUTHENTICATION', false);
    }
    if (response.status === 429) throw new RerankerProviderError('RATE_LIMITED', true);
    if (response.status >= 500) throw new RerankerProviderError('UPSTREAM_5XX', true);
    if (!response.ok) throw new RerankerProviderError('SCHEMA_ERROR', false);
    return (await response.json()) as unknown;
  }
}

/** 仅用于 test/external-ci 的确定性 Reranker。 */
export class FixtureRerankerAdapter implements RerankerPort {
  public constructor(private readonly config: AppConfig) {}

  public checkHealth(options: ProviderCallOptions): Promise<void> {
    return options.signal.aborted ? Promise.reject(options.signal.reason) : Promise.resolve();
  }

  public getMetadata(options: ProviderCallOptions): Promise<RerankerMetadata> {
    if (options.signal.aborted) return Promise.reject(options.signal.reason);
    return Promise.resolve({
      provider: 'fixture',
      modelId: this.config.reranker.modelId,
      revision: this.config.reranker.revision,
      protocolVersion: this.config.reranker.protocolVersion,
      maximumCandidates: this.config.reranker.maxCandidates,
      maximumInputTokens: this.config.reranker.maxInputTokens,
    });
  }

  public rerank(input: RerankInput, options: ProviderCallOptions): Promise<RerankResponse> {
    if (options.signal.aborted) return Promise.reject(options.signal.reason);
    const queryTokens = tokens(input.query);
    const scores = input.documents
      .map((document) => {
        const documentTokens = tokens(`${document.title} ${document.content}`);
        const overlap = [...queryTokens].filter((token) => documentTokens.has(token)).length;
        return {
          candidateId: document.candidateId,
          score: overlap / Math.max(1, queryTokens.size),
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score || left.candidateId.localeCompare(right.candidateId),
      )
      .slice(0, input.topN)
      .map((score, index) => ({ ...score, rank: index + 1 }));
    return Promise.resolve({
      modelId: this.config.reranker.modelId,
      revision: this.config.reranker.revision,
      scores,
    });
  }
}

function assertMetadata(config: AppConfig, metadata: RerankerMetadata): void {
  if (
    metadata.modelId !== config.reranker.modelId ||
    metadata.revision !== config.reranker.revision ||
    metadata.protocolVersion !== config.reranker.protocolVersion ||
    metadata.maximumCandidates < config.reranker.maxCandidates ||
    metadata.maximumInputTokens < config.reranker.maxInputTokens
  ) {
    throw new RerankerProviderError('VERSION_MISMATCH', false);
  }
}

function classifyRerankerError(error: unknown, parentSignal: AbortSignal): RerankerProviderError {
  if (error instanceof RerankerProviderError) return error;
  if (parentSignal.aborted) return new RerankerProviderError('CANCELLED', false);
  if (error instanceof Error && error.message === '远程调用单次超时') {
    return new RerankerProviderError('TIMEOUT', true);
  }
  if (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name)) {
    return new RerankerProviderError('TIMEOUT', true);
  }
  return new RerankerProviderError('NETWORK', true);
}

/** Reranker 错误到通用重试/熔断分类的无敏感映射。 */
function rerankerFailureKind(error: RerankerProviderError): RemoteFailureKind {
  if (error.code === 'CANCELLED') return 'CANCELLED';
  if (error.code === 'TIMEOUT') return 'TIMEOUT';
  if (error.code === 'RATE_LIMITED') return 'RATE_LIMITED';
  if (error.code === 'AUTHENTICATION') return 'AUTHENTICATION';
  if (error.code === 'VERSION_MISMATCH') return 'VERSION';
  if (error.code === 'SCHEMA_ERROR') return 'SCHEMA';
  if (error.code === 'PARTIAL_RESULT') return 'TERMINAL';
  return 'TRANSIENT';
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/${path.replace(/^\/+/, '')}`;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}|[\p{Script=Han}]/gu) ?? []);
}

/**
 * 把供应商分数统一为平台 0..1 置信度。
 *
 * probability 越界说明配置或接口契约不匹配，直接失败；logit 使用数值稳定 Sigmoid 且只在
 * Adapter 边界执行一次，避免业务层把“排名分”误当概率再重复归一化。
 */
function normalizeRerankerScore(
  score: number,
  scoreType: AppConfig['reranker']['scoreType'],
): number {
  if (scoreType === 'probability') {
    if (score < 0 || score > 1) throw new RerankerProviderError('SCHEMA_ERROR', false);
    return score;
  }
  if (score >= 0) return 1 / (1 + Math.exp(-score));
  const exponent = Math.exp(score);
  return exponent / (1 + exponent);
}
