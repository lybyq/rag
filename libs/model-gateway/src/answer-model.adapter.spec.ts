/**
 * 结构化答案模型 Adapter 的 Schema、版本、引用白名单和敏感错误测试。
 *
 * @requirement ANS-006
 * @requirement ANS-009
 * @requirement ANS-013
 * @requirement ANS-019
 */
import { loadAppConfig } from '@rag/config';
import type { GenerateAnswerDraftInput, ProviderCallOptions } from '@rag/application';
import type { AnswerDraft, EvidenceBundle } from '@rag/contracts';
import { HttpAnswerModelAdapter } from './answer-model.adapter';

const sourceId = '11111111-1111-4111-8111-111111111111';
const config = loadAppConfig({
  APP_ENV: 'development',
  PROVIDER_PROFILE: 'external-dev',
  LLM_ADAPTER: 'openai-compatible',
  LLM_BASE_URL: 'https://deepseek.example/v1',
  LLM_MODEL_ID: 'deepseek-chat',
  LLM_REVISION: 'api-r1',
});

describe('[ANS-009] OpenAI-compatible structured answer adapter', () => {
  it('解析有引用的结构化 Draft 并请求 JSON 模式', async () => {
    const fetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
      async (_request, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          response_format: { type: 'json_object' },
        });
        return openAi({
          summary: '制度结论',
          claims: [
            {
              claimId: 'claim-1',
              kind: 'FACT',
              text: '制度结论',
              sourceIds: [sourceId],
              calculationId: null,
              supportMode: 'DIRECT',
            },
          ],
          caveats: [],
          followUpQuestion: null,
        });
      },
    );
    await expect(
      new HttpAnswerModelAdapter(config, fetcher as typeof fetch).generateDraft(
        {
          question: '问题',
          route: 'ANSWER',
          context: {
            text: '安全上下文',
            includedSourceIds: [sourceId],
            sourceWindows: [{ sourceId, content: '差旅制度规定住宿上限为 500 元。' }],
            omittedSourceIds: [],
            estimatedTokens: 10,
            tokenBudget: 100,
          },
          calculations: [],
          directEvidenceOnly: false,
        },
        options(),
      ),
    ).resolves.toMatchObject({ claims: [{ sourceIds: [sourceId] }] });
  });

  it('拒绝模型伪造 Evidence Rerank sourceId', async () => {
    const fetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () =>
      openAi({ orderedSourceIds: ['22222222-2222-4222-8222-222222222222'], reason: '伪造' }),
    );
    await expect(
      new HttpAnswerModelAdapter(config, fetcher as typeof fetch).rerankEvidence(
        { question: '问题', bundle: bundle() },
        options(),
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_ERROR', retryable: false });
  });

  it('版本或 Schema 错误不重试，错误消息不泄漏模型原文', async () => {
    const secret = 'SECRET_DOCUMENT_BODY';
    const fetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
      async () =>
        new Response(
          JSON.stringify({ model: 'wrong-model', choices: [{ message: { content: secret } }] }),
          {
            status: 200,
          },
        ),
    );
    const error = await new HttpAnswerModelAdapter(config, fetcher as typeof fetch)
      .generateDraft(
        {
          question: '问题',
          route: 'ANSWER',
          context: {
            text: secret,
            includedSourceIds: [sourceId],
            sourceWindows: [{ sourceId, content: '差旅制度规定住宿上限为 500 元。' }],
            omittedSourceIds: [],
            estimatedTokens: 10,
            tokenBudget: 100,
          },
          calculations: [],
          directEvidenceOnly: false,
        },
        options(),
      )
      .catch((caught: unknown) => caught);
    expect(error).toEqual(expect.objectContaining({ code: 'VERSION_MISMATCH', retryable: false }));
    expect(String(error)).not.toContain(secret);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('父级取消不发起请求，单次超时只进行有限重试', async () => {
    const cancelledFetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      new HttpAnswerModelAdapter(config, cancelledFetcher as typeof fetch).generateDraft(
        draftInput(),
        options(controller.signal),
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    expect(cancelledFetcher).not.toHaveBeenCalled();

    const timeoutFetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
      (_request, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    await expect(
      new HttpAnswerModelAdapter(config, timeoutFetcher as typeof fetch).generateDraft(
        draftInput(),
        options(undefined, 5),
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(timeoutFetcher).toHaveBeenCalledTimes(2);
  });

  it('429 可重试后成功，连续 5xx 返回稳定错误', async () => {
    const rateLimited = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(openAi(draftContent()));
    await expect(
      new HttpAnswerModelAdapter(config, rateLimited as typeof fetch).generateDraft(
        draftInput(),
        options(),
      ),
    ).resolves.toMatchObject({ summary: '制度结论' });
    expect(rateLimited).toHaveBeenCalledTimes(2);

    const unavailable = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(
      new HttpAnswerModelAdapter(config, unavailable as typeof fetch).generateDraft(
        draftInput(),
        options(),
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_5XX', retryable: true });
    expect(unavailable).toHaveBeenCalledTimes(2);
  });

  it('拒绝 Evidence Rerank 部分结果，并用实际配置记录 Semantic Judge 版本', async () => {
    const partial = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () =>
      openAi({ orderedSourceIds: [], reason: '漏项' }),
    );
    await expect(
      new HttpAnswerModelAdapter(config, partial as typeof fetch).rerankEvidence(
        { question: '问题', bundle: bundle() },
        options(),
      ),
    ).rejects.toMatchObject({ code: 'PARTIAL_RESULT', retryable: false });

    const judge = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () =>
      openAi({
        reason: '语义支持',
        supportedClaimIds: ['claim-1'],
        unsupportedClaimIds: [],
      }),
    );
    await expect(
      new HttpAnswerModelAdapter(config, judge as typeof fetch).judgeGrounding(
        {
          draft: draftContent(),
          bundle: bundle(),
          claimIds: ['claim-1'],
          reason: '规则无法判断',
        },
        options(),
      ),
    ).resolves.toMatchObject({ modelId: 'deepseek-chat', revision: 'api-r1' });
  });

  it('OPT-009 将 vLLM 截断与 reasoning-only 分开分类，且不把推理文本当答案 JSON', async () => {
    const truncated = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () =>
      openAiRaw({
        finishReason: 'length',
        content: '{"summary":"未完成',
        reasoningContent: '内部推理不得外泄',
      }),
    );
    await expect(
      new HttpAnswerModelAdapter(config, truncated as typeof fetch).generateDraft(
        draftInput(),
        options(),
      ),
    ).rejects.toMatchObject({ code: 'PARTIAL_RESULT', retryable: false });

    const reasoningOnly = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () =>
      openAiRaw({
        finishReason: 'stop',
        content: null,
        reasoningContent: JSON.stringify(draftContent()),
      }),
    );
    await expect(
      new HttpAnswerModelAdapter(config, reasoningOnly as typeof fetch).generateDraft(
        draftInput(),
        options(),
      ),
    ).rejects.toMatchObject({ code: 'SCHEMA_ERROR', retryable: false });
  });

  it('OPT-009 可关闭 response_format，并给生成、重排、Judge 使用不同输出预算', async () => {
    const promptOnlyConfig = loadAppConfig({
      APP_ENV: 'development',
      PROVIDER_PROFILE: 'external-dev',
      LLM_ADAPTER: 'openai-compatible',
      LLM_BASE_URL: 'https://glm-vllm.internal/v1',
      LLM_MODEL_ID: 'glm-4.7',
      LLM_REVISION: 'served-r1',
      LLM_JSON_MODE: 'prompt-only',
      LLM_GENERATION_MAX_OUTPUT_TOKENS: '3000',
      LLM_RERANK_MAX_OUTPUT_TOKENS: '700',
      LLM_JUDGE_MAX_OUTPUT_TOKENS: '500',
    });
    const budgets: number[] = [];
    const fetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
      async (_request, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty('response_format');
        budgets.push(body['max_tokens'] as number);
        const maxTokens = body['max_tokens'];
        if (maxTokens === 3000) return openAi(draftContent(), 'glm-4.7');
        if (maxTokens === 700) {
          return openAi({ orderedSourceIds: [sourceId], reason: '已重排' }, 'glm-4.7');
        }
        return openAi(
          { reason: '支持', supportedClaimIds: ['claim-1'], unsupportedClaimIds: [] },
          'glm-4.7',
        );
      },
    );
    const adapter = new HttpAnswerModelAdapter(promptOnlyConfig, fetcher as typeof fetch);
    await adapter.generateDraft(draftInput(), options());
    await adapter.rerankEvidence({ question: '问题', bundle: bundle() }, options());
    await adapter.judgeGrounding(
      { draft: draftContent(), bundle: bundle(), claimIds: ['claim-1'], reason: '待判断' },
      options(),
    );
    expect(budgets).toEqual([3000, 700, 500]);
  });
});

function draftInput(): GenerateAnswerDraftInput {
  return {
    question: '问题',
    route: 'ANSWER' as const,
    context: {
      text: '安全上下文',
      includedSourceIds: [sourceId],
      sourceWindows: [{ sourceId, content: '差旅制度规定住宿上限为 500 元。' }],
      omittedSourceIds: [],
      estimatedTokens: 10,
      tokenBudget: 100,
    },
    calculations: [],
    directEvidenceOnly: false,
  };
}

function draftContent(): AnswerDraft {
  return {
    summary: '制度结论',
    claims: [
      {
        claimId: 'claim-1' as const,
        kind: 'FACT' as const,
        text: '制度结论',
        sourceIds: [sourceId],
        calculationId: null,
        supportMode: 'DIRECT' as const,
      },
    ],
    caveats: [],
    followUpQuestion: null,
  };
}

function bundle(): EvidenceBundle {
  return {
    runId: '33333333-3333-4333-8333-333333333333',
    bundleSha256: 'a'.repeat(64),
    sources: [
      {
        sourceId,
        relation: 'SELF',
        originCandidateId: 'chunk-1',
        manifestId: '44444444-4444-4444-8444-444444444444',
        spaceId: '55555555-5555-4555-8555-555555555555',
        documentId: '66666666-6666-4666-8666-666666666666',
        documentVersionId: '77777777-7777-4777-8777-777777777777',
        contentRevision: 1,
        chunkId: 'chunk-1',
        title: '制度',
        headingPath: [],
        content: '正文',
        sourceLocations: [],
        authority: 'POLICY',
        publishedAt: '2026-01-01T00:00:00.000Z',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: null,
        retrievalScore: 0.9,
        rerankerScore: 0.9,
        subQuestionIndexes: [0],
      },
    ],
    coverage: [],
    conflicts: [],
    missingConditions: [],
    confidence: 0.9,
    degraded: false,
  };
}

function openAi(content: unknown, model = 'deepseek-chat'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function openAiRaw(input: {
  readonly finishReason: string;
  readonly content: string | null;
  readonly reasoningContent?: string;
}): Response {
  return new Response(
    JSON.stringify({
      model: 'deepseek-chat',
      choices: [
        {
          finish_reason: input.finishReason,
          message: { content: input.content, reasoning_content: input.reasoningContent ?? null },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function options(signal?: AbortSignal, timeoutMs = 1_000): ProviderCallOptions {
  return {
    signal: signal ?? new AbortController().signal,
    timeoutMs,
    deadlineAt: new Date(Date.now() + 10_000),
  };
}
