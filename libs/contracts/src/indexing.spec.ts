/** M05 Zod 契约的反例和可复现性测试。 */
import {
  EmbeddingBatchResponseSchema,
  EmbeddingProfileSchema,
  SparseVectorSchema,
} from './indexing';

describe('[IDX-001][IDX-002] indexing contracts', () => {
  it('拒绝重复或乱序 Sparse 索引', () => {
    expect(() => SparseVectorSchema.parse({ indices: [1, 1], values: [0.2, 0.3] })).toThrow(
      /严格递增/,
    );
    expect(() => SparseVectorSchema.parse({ indices: [1, 2], values: [0.2] })).toThrow(/数量/);
  });

  it('拒绝同一 itemId 同时出现在成功和失败结果', () => {
    expect(() =>
      EmbeddingBatchResponseSchema.parse({
        outputs: [
          {
            itemId: 'item-1',
            contentSha256: 'a'.repeat(64),
            dense: [1],
            sparse: null,
            modelId: 'model',
            revision: '1',
          },
        ],
        failures: [
          {
            itemId: 'item-1',
            code: 'TIMEOUT',
            retryable: true,
            publicMessage: '超时',
          },
        ],
      }),
    ).toThrow(/重复/);
  });

  it('Profile 冻结模型、Tokenizer、维度、Sparse 和双模板版本', () => {
    expect(
      EmbeddingProfileSchema.parse({
        profileId: 'bge-m3-v1',
        providerProfile: 'intranet-production',
        provider: 'internal-bge',
        modelId: 'BAAI/bge-m3',
        revision: '2026.08.1',
        protocolVersion: '1',
        tokenizerRevision: 'tokenizer-1',
        denseDimension: 1024,
        normalizeDense: true,
        sparseFormatVersion: 'sparse-v1',
        documentTemplateVersion: 'document-v1',
        queryTemplateVersion: 'query-v1',
        maxInputTokens: 8192,
        maxBatchSize: 32,
      }),
    ).toMatchObject({ denseDimension: 1024, sparseFormatVersion: 'sparse-v1' });
  });
});
