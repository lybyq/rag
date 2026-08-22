/** M05 Milvus Adapter Schema、部分失败、取消、Filter 安全和维度门禁测试。 */
import { loadAppConfig } from '@rag/config';
import type { EmbeddingProfile } from '@rag/contracts';
import type { IndexVectorRecord, ProviderCallOptions } from '@rag/application';
import { MilvusVectorIndexAdapter, type MilvusIndexSdkClient } from './milvus-vector-index.adapter';

describe('[IDX-006][IDX-007][IDX-009][IDX-010] MilvusVectorIndexAdapter', () => {
  it('创建 Profile 专属 Collection，只有短摘要/定位元数据和 Dense/Sparse 向量', async () => {
    const client = fakeClient();
    const adapter = new MilvusVectorIndexAdapter(config(), client);
    await adapter.ensureProfileCollection(
      profile(),
      'rag_chunks_abcd',
      'rag_active_abcd',
      options(),
    );

    const request = (client.createCollection as jest.Mock).mock.calls[0]?.[0] as {
      fields: { name: string; dim?: number }[];
    };
    expect(request.fields.find((field) => field.name === 'dense_vector')?.dim).toBe(4);
    expect(request.fields.map((field) => field.name)).toContain('sparse_vector');
    expect(request.fields.map((field) => field.name)).toContain('short_summary');
    expect(request.fields.map((field) => field.name)).not.toEqual(
      expect.arrayContaining(['display_content', 'embedding_text', 'full_text']),
    );
  });

  it('把 SDK err_index 映射为仅失败主键的可重试结果', async () => {
    const client = fakeClient();
    client.upsert = jest.fn(async () => ({ succ_index: [0], err_index: [1] }));
    const adapter = new MilvusVectorIndexAdapter(config(), client);
    const records = [record('a'.repeat(64)), record('b'.repeat(64))];

    await expect(
      adapter.upsertManifestRecords('rag_chunks_abcd', records, options()),
    ).resolves.toEqual({
      succeededVectorIds: ['a'.repeat(64)],
      retryableVectorIds: ['b'.repeat(64)],
      terminalVectorIds: [],
    });
  });

  it('已存在 Collection 的维度不匹配时拒绝写入', async () => {
    const client = fakeClient();
    client.hasCollection = jest.fn(async () => ({ value: true }));
    client.describeCollection = jest.fn(async () => ({
      schema: { fields: [{ name: 'dense_vector', dim: 3 }, { name: 'sparse_vector' }] },
    }));
    const adapter = new MilvusVectorIndexAdapter(config(), client);
    await expect(
      adapter.ensureProfileCollection(profile(), 'rag_chunks_abcd', 'rag_active_abcd', options()),
    ).rejects.toThrow(/dimension/);
    expect(client.upsert).not.toHaveBeenCalled();
  });

  it('拒绝客户端式任意 Filter 输入，并传播父级取消', async () => {
    const client = fakeClient();
    const adapter = new MilvusVectorIndexAdapter(config(), client);
    await expect(
      adapter.deleteManifestRecords('rag_chunks_abcd', 'x" or true', options()),
    ).rejects.toThrow(/UUID/);

    client.query = jest.fn(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = adapter.listManifestRecordFacts(
      'rag_chunks_abcd',
      '11111111-1111-4111-8111-111111111111',
      options(controller.signal),
    );
    controller.abort(new Error('用户取消'));
    await expect(pending).rejects.toThrow('用户取消');
  });

  it('[IDX-016] 离线评测查询强制绑定候选 Manifest 且只返回最小命中事实', async () => {
    const client = fakeClient();
    client.search = jest.fn(async () => ({
      results: [
        [
          {
            id: 'a'.repeat(64),
            document_id: '33333333-3333-4333-8333-333333333333',
            score: 0.91,
          },
        ],
      ],
    }));
    const adapter = new MilvusVectorIndexAdapter(config(), client);

    await expect(
      adapter.searchManifestDense(
        'rag_chunks_abcd',
        '11111111-1111-4111-8111-111111111111',
        [1, 0, 0, 0],
        5,
        options(),
      ),
    ).resolves.toEqual([
      {
        vectorId: 'a'.repeat(64),
        documentId: '33333333-3333-4333-8333-333333333333',
        score: 0.91,
      },
    ]);
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: 'manifest_id == "11111111-1111-4111-8111-111111111111"',
        output_fields: ['vector_id', 'document_id'],
      }),
    );
  });
});

function profile(): EmbeddingProfile {
  return {
    profileId: 'bge-v1',
    providerProfile: 'intranet-production',
    provider: 'internal',
    modelId: 'bge',
    revision: 'r1',
    protocolVersion: '1',
    tokenizerRevision: 'tok1',
    denseDimension: 4,
    normalizeDense: true,
    sparseFormatVersion: 'sparse-v1',
    documentTemplateVersion: 'doc-v1',
    queryTemplateVersion: 'query-v1',
    maxInputTokens: 1024,
    maxBatchSize: 32,
  };
}

function record(vectorId: string): IndexVectorRecord {
  return {
    vectorId,
    manifestId: '11111111-1111-4111-8111-111111111111',
    spaceId: '22222222-2222-4222-8222-222222222222',
    documentId: '33333333-3333-4333-8333-333333333333',
    documentVersionId: '44444444-4444-4444-8444-444444444444',
    contentRevision: 1,
    chunkId: 'chunk-1',
    ordinal: 1,
    contentSha256: 'c'.repeat(64),
    embeddingProfileId: 'bge-v1',
    shortSummary: '短摘要',
    headingPath: ['标题'],
    sourceLocations: [{ pageNo: 1 }],
    dense: [1, 0, 0, 0],
    sparse: { indices: [1], values: [0.5] },
  };
}

function fakeClient(): MilvusIndexSdkClient & Record<string, jest.Mock> {
  return {
    hasCollection: jest.fn(async () => ({ value: false })),
    createCollection: jest.fn(async () => ({ error_code: 'Success' })),
    describeCollection: jest.fn(async () => ({})),
    createAlias: jest.fn(async () => ({ error_code: 'Success' })),
    alterAlias: jest.fn(async () => ({ error_code: 'Success' })),
    loadCollection: jest.fn(async () => ({ error_code: 'Success' })),
    upsert: jest.fn(async () => ({ succ_index: [], err_index: [] })),
    query: jest.fn(async () => ({ data: [] })),
    search: jest.fn(async () => ({ results: [] })),
    delete: jest.fn(async () => ({ error_code: 'Success' })),
    closeConnection: jest.fn(async () => undefined),
  } as unknown as MilvusIndexSdkClient & Record<string, jest.Mock>;
}

function config(): ReturnType<typeof loadAppConfig> {
  return loadAppConfig({
    VECTOR_STORE_ADAPTER: 'milvus',
    EMBEDDING_DENSE_DIMENSION: '4',
    EMBEDDING_MAX_INPUT_TOKENS: '1024',
    EMBEDDING_MAX_BATCH_TOKENS: '2048',
    CHUNK_CHILD_MAX_TOKENS: '512',
  });
}

function options(signal = new AbortController().signal): ProviderCallOptions {
  return { signal, timeoutMs: 1000, deadlineAt: new Date(Date.now() + 2000) };
}
