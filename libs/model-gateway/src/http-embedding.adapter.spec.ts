/** M05 HTTP Embedding Adapter 正常、超时、取消、Schema、429/5xx 与用途契约测试。 */
import { loadAppConfig } from '@rag/config';
import type { EmbeddingProviderMetadata } from '@rag/contracts';
import type { ProviderCallOptions } from '@rag/application';
import { HttpEmbeddingAdapter } from './http-embedding.adapter';

const input = {
  itemId: 'chunk-1',
  contentSha256: 'a'.repeat(64),
  text: '不会进入测试日志的正文',
  tokenCount: 8,
};

describe('[IDX-001][IDX-003][IDX-004][CFG-006] HttpEmbeddingAdapter', () => {
  it('读取真实 metadata，并向文档端点显式发送 DOCUMENT purpose', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = jest.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/metadata')) return jsonResponse(metadata());
      if (String(url).endsWith('/health')) return jsonResponse({ status: 'ok' });
      return jsonResponse({
        outputs: [
          {
            itemId: input.itemId,
            contentSha256: input.contentSha256,
            dense: [1, 0, 0, 0],
            sparse: null,
            modelId: 'model',
            revision: 'r1',
          },
        ],
        failures: [],
      });
    });
    const adapter = new HttpEmbeddingAdapter(config(), fetchMock as typeof fetch);
    const options = callOptions();
    await adapter.checkHealth(options);
    await expect(adapter.getMetadata(options)).resolves.toMatchObject({ denseDimension: 4 });
    await expect(adapter.embedDocuments([input], options)).resolves.toMatchObject({ failures: [] });
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toMatchObject({ purpose: 'DOCUMENT' });
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [503, 'UPSTREAM_5XX'],
  ])('把 HTTP %i 转为逐项可重试失败 %s', async (status, expectedCode) => {
    const adapter = new HttpEmbeddingAdapter(
      config(),
      jest.fn(async () => new Response('{}', { status })) as typeof fetch,
    );
    const result = await adapter.embedDocuments([input], callOptions());
    expect(result.failures[0]).toMatchObject({ code: expectedCode, retryable: true });
  });

  it('响应 Schema 错误不可重试，且不返回原始响应正文', async () => {
    const adapter = new HttpEmbeddingAdapter(
      config(),
      jest.fn(async () => jsonResponse({ secret: 'do-not-leak' })) as typeof fetch,
    );
    const result = await adapter.embedDocuments([input], callOptions());
    expect(result.failures[0]).toMatchObject({ code: 'SCHEMA_ERROR', retryable: false });
    expect(JSON.stringify(result)).not.toContain('do-not-leak');
  });

  it('单次网络超时转换为可重试失败，父级取消则立即向上传播', async () => {
    const timeoutAdapter = new HttpEmbeddingAdapter(
      config(),
      jest.fn(async () => Promise.reject(new Error('socket timeout'))) as typeof fetch,
    );
    await expect(timeoutAdapter.embedDocuments([input], callOptions())).resolves.toMatchObject({
      failures: [expect.objectContaining({ code: 'TIMEOUT', retryable: true })],
    });

    const controller = new AbortController();
    controller.abort(new Error('用户取消'));
    await expect(
      timeoutAdapter.embedDocuments([input], callOptions(controller.signal)),
    ).rejects.toThrow('用户取消');
  });
});

function config(): ReturnType<typeof loadAppConfig> {
  return loadAppConfig({
    EMBEDDING_ADAPTER: 'http',
    EMBEDDING_BASE_URL: 'http://embedding.internal/',
    EMBEDDING_MODEL_ID: 'model',
    EMBEDDING_REVISION: 'r1',
    EMBEDDING_DENSE_DIMENSION: '4',
    EMBEDDING_MAX_INPUT_TOKENS: '1024',
    EMBEDDING_MAX_BATCH_TOKENS: '2048',
    CHUNK_CHILD_MAX_TOKENS: '512',
  });
}

function metadata(): EmbeddingProviderMetadata {
  return {
    provider: 'internal',
    modelId: 'model',
    revision: 'r1',
    protocolVersion: '1',
    tokenizerRevision: 'fixture-tokenizer-v1',
    denseDimension: 4,
    normalizeDense: true,
    sparseFormatVersion: null,
    maxInputTokens: 1024,
    maxBatchSize: 32,
    capabilities: ['query', 'document', 'dense'],
  };
}

function callOptions(signal = new AbortController().signal): ProviderCallOptions {
  return { signal, timeoutMs: 1000, deadlineAt: new Date(Date.now() + 2000) };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
