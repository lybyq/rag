/**
 * 查询规划与混合检索 查询改写 LLM Adapter。
 *
 * `openai-compatible` 适配 DeepSeek/OpenAI-compatible Chat Completions；`http` 使用项目内部
 * `/v1/query-rewrite` 契约。两者都在 Deadline、单次超时和 AbortSignal 内执行，并用 Zod
 * 拒绝非结构化输出。日志与错误不包含问题或模型原始响应。
 *
 * @requirement RET-004
 * @requirement RET-007
 */
import type { ProviderCallOptions, QueryRewriteInput, QueryRewritePort } from '@rag/application';
import type { AppConfig } from '@rag/config';
import { QueryRewriteSuggestionSchema, type QueryRewriteSuggestion } from '@rag/contracts';
import { z } from 'zod';

const OpenAiResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
});

const InternalResponseSchema = z.object({
  modelId: z.string().min(1),
  revision: z.string().min(1),
  suggestion: QueryRewriteSuggestionSchema,
});

/** 可观测且不携带正文的改写 Provider 错误。 */
export class QueryRewriteProviderError extends Error {
  public constructor(
    public readonly code:
      | 'TIMEOUT'
      | 'CANCELLED'
      | 'RATE_LIMITED'
      | 'UPSTREAM_5XX'
      | 'AUTHENTICATION'
      | 'SCHEMA_ERROR'
      | 'VERSION_MISMATCH'
      | 'NETWORK',
    public readonly retryable: boolean,
  ) {
    super(`查询改写 Provider 调用失败：${code}`);
    this.name = 'QueryRewriteProviderError';
  }
}

/** 真实 HTTP/Chat Completions 改写 Adapter。 */
export class HttpQueryRewriteAdapter implements QueryRewritePort {
  private readonly fetcher: typeof fetch;

  public constructor(
    private readonly config: AppConfig,
    fetcher: typeof fetch = fetch,
  ) {
    this.fetcher = fetcher;
  }

  /** 最多对 429、5xx 和网络失败重试一次；Schema、认证与版本错误不重试。 */
  public async rewrite(
    input: QueryRewriteInput,
    options: ProviderCallOptions,
  ): Promise<QueryRewriteSuggestion> {
    let lastError: QueryRewriteProviderError | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.invoke(input, options);
      } catch (error) {
        const classified = classifyError(error, options.signal);
        lastError = classified;
        if (!classified.retryable || attempt === 2) throw classified;
      }
    }
    throw lastError ?? new QueryRewriteProviderError('NETWORK', true);
  }

  private async invoke(
    input: QueryRewriteInput,
    options: ProviderCallOptions,
  ): Promise<QueryRewriteSuggestion> {
    if (options.signal.aborted) throw new QueryRewriteProviderError('CANCELLED', false);
    const remaining = options.deadlineAt.getTime() - Date.now();
    if (remaining <= 0) throw new QueryRewriteProviderError('TIMEOUT', true);
    const timeoutSignal = AbortSignal.timeout(Math.min(options.timeoutMs, remaining));
    const signal = AbortSignal.any([options.signal, timeoutSignal]);
    const internal = this.config.llm.adapter === 'http';
    const response = await this.fetcher(
      internal
        ? joinUrl(this.config.llm.baseUrl, 'v1/query-rewrite')
        : joinUrl(this.config.llm.baseUrl, 'chat/completions'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.llm.apiKey ? { authorization: `Bearer ${this.config.llm.apiKey}` } : {}),
        },
        body: JSON.stringify(
          internal ? internalBody(this.config, input) : openAiBody(this.config, input),
        ),
        signal,
      },
    );
    if (response.status === 401 || response.status === 403) {
      throw new QueryRewriteProviderError('AUTHENTICATION', false);
    }
    if (response.status === 429) throw new QueryRewriteProviderError('RATE_LIMITED', true);
    if (response.status >= 500) throw new QueryRewriteProviderError('UPSTREAM_5XX', true);
    if (!response.ok) throw new QueryRewriteProviderError('SCHEMA_ERROR', false);
    const payload = (await response.json()) as unknown;
    if (internal) {
      const parsed = InternalResponseSchema.safeParse(payload);
      if (!parsed.success) throw new QueryRewriteProviderError('SCHEMA_ERROR', false);
      if (
        parsed.data.modelId !== this.config.llm.modelId ||
        parsed.data.revision !== this.config.llm.revision
      ) {
        throw new QueryRewriteProviderError('VERSION_MISMATCH', false);
      }
      return parsed.data.suggestion;
    }
    const parsed = OpenAiResponseSchema.safeParse(payload);
    if (!parsed.success) throw new QueryRewriteProviderError('SCHEMA_ERROR', false);
    if (parsed.data.model && parsed.data.model !== this.config.llm.modelId) {
      throw new QueryRewriteProviderError('VERSION_MISMATCH', false);
    }
    return parseSuggestion(parsed.data.choices[0]?.message.content ?? '');
  }
}

/** 只用于 test/external-ci 的确定性改写器；生产配置门禁禁止选择 fixture。 */
export class FixtureQueryRewriteAdapter implements QueryRewritePort {
  public rewrite(
    input: QueryRewriteInput,
    options: ProviderCallOptions,
  ): Promise<QueryRewriteSuggestion> {
    if (options.signal.aborted) return Promise.reject(options.signal.reason);
    const questions = input.question
      .split(/(?:以及|并且|同时|；|;|\band\b)/iu)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, input.maximumSubQuestions);
    return Promise.resolve({
      rewrittenQuery: input.question.trim(),
      subQuestions: questions,
      entities: input.exactLiterals.map((literal) => ({
        kind: literal.kind,
        value: literal.value,
      })),
    });
  }
}

function openAiBody(config: AppConfig, input: QueryRewriteInput): Record<string, unknown> {
  return {
    model: config.llm.modelId,
    temperature: 0,
    max_tokens: Math.min(config.llm.maxOutputTokens, 2_048),
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '你是企业检索查询改写器。只返回 JSON：rewrittenQuery、subQuestions（最多4个）、entities（kind/value）。不得返回 SQL、Milvus filter、权限或答案；必须原样保留输入 exactLiterals。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          question: input.question,
          exactLiterals: input.exactLiterals.map(({ kind, value }) => ({ kind, value })),
          historyEntities: input.historyEntities,
          maximumSubQuestions: input.maximumSubQuestions,
        }),
      },
    ],
  };
}

function internalBody(config: AppConfig, input: QueryRewriteInput): Record<string, unknown> {
  return {
    protocolVersion: config.llm.protocolVersion,
    modelId: config.llm.modelId,
    revision: config.llm.revision,
    input,
  };
}

function parseSuggestion(content: string): QueryRewriteSuggestion {
  try {
    const unwrapped = content
      .trim()
      .replace(/^```(?:json)?\s*/iu, '')
      .replace(/\s*```$/u, '');
    return QueryRewriteSuggestionSchema.parse(JSON.parse(unwrapped) as unknown);
  } catch {
    throw new QueryRewriteProviderError('SCHEMA_ERROR', false);
  }
}

function classifyError(error: unknown, parentSignal: AbortSignal): QueryRewriteProviderError {
  if (error instanceof QueryRewriteProviderError) return error;
  if (parentSignal.aborted) return new QueryRewriteProviderError('CANCELLED', false);
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new QueryRewriteProviderError('TIMEOUT', true);
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new QueryRewriteProviderError('TIMEOUT', true);
  }
  return new QueryRewriteProviderError('NETWORK', true);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/${path.replace(/^\/+/, '')}`;
}
