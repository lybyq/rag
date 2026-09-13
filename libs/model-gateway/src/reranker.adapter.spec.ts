/**
 * Reranker HTTP Adapter 契约测试：正常、超时、取消、Schema、429/5xx、版本和部分结果。
 *
 * @requirement ANS-002
 * @requirement CFG-004
 * @requirement CFG-006
 */
import { loadAppConfig } from '@rag/config';
import type { ProviderCallOptions } from '@rag/application';
import { HttpRerankerAdapter } from './reranker.adapter';

const config = loadAppConfig({
  APP_ENV: 'development',
  PROVIDER_PROFILE: 'external-dev',
  RERANKER_ADAPTER: 'http',
  RERANKER_MODEL_ID: 'bge-reranker',
  RERANKER_REVISION: 'r1',
  RERANKER_PROTOCOL_VERSION: '1',
  RERANKER_MAX_CANDIDATES: '2',
  RERANKER_TOP_N: '2',
  RETRIEVAL_CANDIDATE_POOL_TOP_K: '2',
  RETRIEVAL_FINAL_TOP_K: '2',
});
const input = {
  query: '差旅标准',
  documents: [
    { candidateId: 'a', title: '制度', content: '差旅标准正文' },
    { candidateId: 'b', title: '其他', content: '其他正文' },
  ],
  topN: 2,
};

describe('[ANS-002][CFG-006] HTTP reranker adapter', () => {
  it('校验元数据并返回完整精排结果', async () => {
    const fetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
      async (request) => {
        const url = String(request);
        if (url.endsWith('/v1/metadata')) {
          return json({
            provider: 'internal',
            modelId: 'bge-reranker',
            revision: 'r1',
            protocolVersion: '1',
            maximumCandidates: 2,
            maximumInputTokens: 8192,
          });
        }
        return json(successPayload());
      },
    );
    const adapter = new HttpRerankerAdapter(config, fetcher as typeof fetch);
    await expect(adapter.getMetadata(options())).resolves.toMatchObject({ revision: 'r1' });
    await expect(adapter.rerank(input, options())).resolves.toMatchObject({
      modelId: 'bge-reranker',
      scores: [
        { candidateId: 'a', score: 0.9, rank: 1 },
        { candidateId: 'b', score: 0.2, rank: 2 },
      ],
    });
  });

  it('OPT-008 按配置把 raw logit 只归一化一次，并按 rank 而非数组顺序输出', async () => {
    const logitConfig = loadAppConfig({
      APP_ENV: 'development',
      PROVIDER_PROFILE: 'external-dev',
      RERANKER_ADAPTER: 'http',
      RERANKER_MODEL_ID: 'bge-reranker',
      RERANKER_REVISION: 'r1',
      RERANKER_PROTOCOL_VERSION: '1',
      RERANKER_MAX_CANDIDATES: '2',
      RERANKER_TOP_N: '2',
      RETRIEVAL_CANDIDATE_POOL_TOP_K: '2',
      RETRIEVAL_FINAL_TOP_K: '2',
      RERANKER_SCORE_TYPE: 'logit',
    });
    const fetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () =>
      json({
        ...successPayload(),
        scores: [
          { candidateId: 'b', score: -2, rank: 2 },
          { candidateId: 'a', score: 2, rank: 1 },
        ],
      }),
    );
    const response = await new HttpRerankerAdapter(logitConfig, fetcher as typeof fetch).rerank(
      input,
      options(),
    );
    expect(response.scores.map((score) => score.candidateId)).toEqual(['a', 'b']);
    expect(response.scores[0]?.score).toBeCloseTo(0.880797, 5);
    expect(response.scores[1]?.score).toBeCloseTo(0.119203, 5);
  });

  it('OPT-008 probability 越界与重复 rank 被稳定拒绝', async () => {
    const invalidProbability = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
      async () =>
        json({
          ...successPayload(),
          scores: [
            { candidateId: 'a', score: 1.2, rank: 1 },
            { candidateId: 'b', score: 0.2, rank: 2 },
          ],
        }),
    );
    await expect(
      new HttpRerankerAdapter(config, invalidProbability as typeof fetch).rerank(input, options()),
    ).rejects.toMatchObject({ code: 'SCHEMA_ERROR', retryable: false });

    const duplicateRank = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () =>
      json({
        ...successPayload(),
        scores: [
          { candidateId: 'a', score: 0.9, rank: 1 },
          { candidateId: 'b', score: 0.2, rank: 1 },
        ],
      }),
    );
    await expect(
      new HttpRerankerAdapter(config, duplicateRank as typeof fetch).rerank(input, options()),
    ).rejects.toMatchObject({ code: 'PARTIAL_RESULT', retryable: false });
  });

  it('父级取消立即终止，不发起网络请求', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const fetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
    await expect(
      new HttpRerankerAdapter(config, fetcher as typeof fetch).rerank(
        input,
        options(controller.signal),
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('单次超时被分类且只有限重试', async () => {
    const fetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(
      (_request, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    await expect(
      new HttpRerankerAdapter(config, fetcher as typeof fetch).rerank(input, options(undefined, 5)),
    ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('429 重试一次后成功，连续 5xx 返回稳定错误', async () => {
    const rateLimited = jest
      .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json(successPayload()));
    await expect(
      new HttpRerankerAdapter(config, rateLimited as typeof fetch).rerank(input, options()),
    ).resolves.toBeDefined();
    expect(rateLimited).toHaveBeenCalledTimes(2);

    const unavailable = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () =>
      json({}, 503),
    );
    await expect(
      new HttpRerankerAdapter(config, unavailable as typeof fetch).rerank(input, options()),
    ).rejects.toMatchObject({ code: 'UPSTREAM_5XX', retryable: true });
    expect(unavailable).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Schema 错误', { unsafe: true }, 'SCHEMA_ERROR'],
    ['版本不匹配', { ...successPayload(), revision: 'r2' }, 'VERSION_MISMATCH'],
    [
      '部分结果',
      { ...successPayload(), scores: [{ candidateId: 'a', score: 0.9, rank: 1 }] },
      'PARTIAL_RESULT',
    ],
    [
      '未知候选',
      {
        ...successPayload(),
        scores: [
          { candidateId: 'a', score: 0.9, rank: 1 },
          { candidateId: 'forged', score: 0.8, rank: 2 },
        ],
      },
      'PARTIAL_RESULT',
    ],
  ])('%s 被拒绝且不重试', async (_name, payload, code) => {
    const fetcher = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () =>
      json(payload),
    );
    await expect(
      new HttpRerankerAdapter(config, fetcher as typeof fetch).rerank(input, options()),
    ).rejects.toEqual(expect.objectContaining({ code, retryable: false }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function successPayload(): Record<string, unknown> {
  return {
    protocolVersion: '1',
    modelId: 'bge-reranker',
    revision: 'r1',
    scores: [
      { candidateId: 'a', score: 0.9, rank: 1 },
      { candidateId: 'b', score: 0.2, rank: 2 },
    ],
  };
}

function options(signal?: AbortSignal, timeoutMs = 1_000): ProviderCallOptions {
  return {
    signal: signal ?? new AbortController().signal,
    timeoutMs,
    deadlineAt: new Date(Date.now() + 10_000),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
