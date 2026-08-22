/** M05 动态批处理与部分失败重试的领域回归测试。 */
import type { EmbeddingBatchResponse, EmbeddingInput } from '@rag/contracts';
import { executeEmbeddingBatches, planEmbeddingBatches } from './embedding-batch';

const inputs: EmbeddingInput[] = [
  { itemId: 'a', contentSha256: 'a'.repeat(64), text: 'A', tokenCount: 6 },
  { itemId: 'b', contentSha256: 'b'.repeat(64), text: 'B', tokenCount: 5 },
  { itemId: 'c', contentSha256: 'c'.repeat(64), text: 'C', tokenCount: 4 },
];

describe('[IDX-004] token-aware embedding batches', () => {
  it('同时遵守条数和 Token 预算，并保持稳定输入顺序', () => {
    expect(planEmbeddingBatches(inputs, { maxBatchItems: 2, maxBatchTokens: 10 })).toEqual([
      [inputs[0]],
      [inputs[1], inputs[2]],
    ]);
  });

  it('只重试部分可重试失败，且并发不会超过配置', async () => {
    let active = 0;
    let maximumActive = 0;
    const attempts = new Map<string, number>();
    const invoke = async (batch: readonly EmbeddingInput[]): Promise<EmbeddingBatchResponse> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      const outputs: EmbeddingBatchResponse['outputs'] = [];
      const failures: EmbeddingBatchResponse['failures'] = [];
      for (const item of batch) {
        const count = (attempts.get(item.itemId) ?? 0) + 1;
        attempts.set(item.itemId, count);
        if (item.itemId === 'b' && count === 1) {
          failures.push({
            itemId: item.itemId,
            code: 'RATE_LIMITED',
            retryable: true,
            publicMessage: '稍后重试',
          });
        } else {
          outputs.push({
            itemId: item.itemId,
            contentSha256: item.contentSha256,
            dense: [count],
            sparse: null,
            modelId: 'fixture',
            revision: '1',
          });
        }
      }
      return { outputs, failures };
    };

    const result = await executeEmbeddingBatches(inputs, invoke, {
      maxBatchItems: 1,
      maxBatchTokens: 10,
      maxConcurrency: 2,
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      maxQueuedItems: 10,
      signal: new AbortController().signal,
    });

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(result.outputs.map((item) => item.itemId).sort()).toEqual(['a', 'b', 'c']);
    expect(result.failures).toEqual([]);
    expect(attempts.get('b')).toBe(2);
    expect(attempts.get('a')).toBe(1);
  });

  it('输入超过背压上限时在调用 Provider 前拒绝', async () => {
    const invoke = jest.fn<Promise<EmbeddingBatchResponse>, [readonly EmbeddingInput[]]>();
    await expect(
      executeEmbeddingBatches(inputs, invoke, {
        maxBatchItems: 2,
        maxBatchTokens: 20,
        maxConcurrency: 1,
        maxAttempts: 2,
        retryBaseDelayMs: 0,
        maxQueuedItems: 2,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/背压/);
    expect(invoke).not.toHaveBeenCalled();
  });
});
