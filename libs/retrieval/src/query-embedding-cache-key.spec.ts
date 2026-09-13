/**
 * Query Embedding 缓存键回归测试。
 *
 * @requirement RET-008
 * @requirement OPT-016
 */
import { buildQueryEmbeddingCacheKey } from './query-embedding-cache-key';

const base = {
  text: '差旅住宿标准是多少？',
  modelId: 'bge-m3',
  revision: '2026-09',
  denseDimension: 1024,
  queryTemplateVersion: 'query-v1',
  normalizeDense: true,
  outputModes: ['dense'] as const,
  sparseFormatVersion: null,
};

describe('[RET-008][OPT-016] query embedding cache key', () => {
  it('相同真实模型输入跨 Run 生成同一个键，且键中不泄漏问题正文', () => {
    const first = buildQueryEmbeddingCacheKey(base);
    const second = buildQueryEmbeddingCacheKey({ ...base });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain(base.text);
  });

  it.each([
    ['text', { text: '北京住宿标准是多少？' }],
    ['model', { modelId: 'bge-m3-new' }],
    ['revision', { revision: '2026-10' }],
    ['dimension', { denseDimension: 768 }],
    ['template', { queryTemplateVersion: 'query-v2' }],
    ['normalize', { normalizeDense: false }],
    ['outputs', { outputModes: ['dense', 'sparse'] as const }],
    ['sparse-format', { sparseFormatVersion: 'csr-v1' }],
  ])('%s 变化时缓存失效', (_name, change) => {
    expect(buildQueryEmbeddingCacheKey({ ...base, ...change })).not.toBe(
      buildQueryEmbeddingCacheKey(base),
    );
  });
});
