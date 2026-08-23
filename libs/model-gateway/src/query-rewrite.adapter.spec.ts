/** 查询规划与混合检索 查询改写 Provider 的正常、超时、取消、Schema、429/5xx 与版本门禁。 */
import type { ProviderCallOptions } from '@rag/application';
import type { AppConfig } from '@rag/config';
import { HttpQueryRewriteAdapter } from './query-rewrite.adapter';

const input = {
  question: '对比制度 A 和制度 B',
  exactLiterals: [],
  historyEntities: [],
  maximumSubQuestions: 4 as const,
};

describe('[RET-004] HttpQueryRewriteAdapter', () => {
  test('解析 OpenAI-compatible JSON 结构化输出', async () => {
    const adapter = new HttpQueryRewriteAdapter(
      config(),
      jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: 'deepseek-chat',
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      rewrittenQuery: '对比制度 A 和制度 B',
                      subQuestions: ['制度 A', '制度 B'],
                      entities: [],
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ) as typeof fetch,
    );
    await expect(adapter.rewrite(input, options())).resolves.toMatchObject({
      subQuestions: ['制度 A', '制度 B'],
    });
  });

  test.each([
    [429, 'RATE_LIMITED'],
    [503, 'UPSTREAM_5XX'],
  ])('HTTP %s 被稳定分类并有限重试', async (status, code) => {
    const fetcher = jest.fn(async () => new Response('{}', { status })) as unknown as typeof fetch;
    const adapter = new HttpQueryRewriteAdapter(config(), fetcher);
    await expect(adapter.rewrite(input, options())).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('Schema 错误不重试', async () => {
    const fetcher = jest.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      new HttpQueryRewriteAdapter(config(), fetcher).rewrite(input, options()),
    ).rejects.toMatchObject({
      code: 'SCHEMA_ERROR',
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('模型版本不匹配默认拒绝', async () => {
    const fetcher = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: 'other-model',
            choices: [{ message: { content: '{}' } }],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    await expect(
      new HttpQueryRewriteAdapter(config(), fetcher).rewrite(input, options()),
    ).rejects.toMatchObject({
      code: 'VERSION_MISMATCH',
    });
  });

  test('父级 AbortSignal 被分类为取消', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      new HttpQueryRewriteAdapter(config(), jest.fn() as unknown as typeof fetch).rewrite(input, {
        ...options(),
        signal: controller.signal,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'CANCELLED' }));
  });

  test('单次超时被稳定分类且只有限重试', async () => {
    const fetcher = jest.fn(async () => {
      throw new DOMException('timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    await expect(
      new HttpQueryRewriteAdapter(config(), fetcher).rewrite(input, options()),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

function options(): ProviderCallOptions {
  return {
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    deadlineAt: new Date(Date.now() + 5_000),
  };
}

function config(): AppConfig {
  return {
    llm: {
      adapter: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'test-key',
      modelId: 'deepseek-chat',
      profileId: 'deepseek-v1',
      revision: 'r1',
      protocolVersion: '1',
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      maxOutputTokens: 1_024,
      temperature: 0,
    },
  } as AppConfig;
}
