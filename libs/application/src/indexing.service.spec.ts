/** M05 编排的幂等复用、不可见构建、对账和失败保持旧版本测试。 */
import type { EmbeddingFact, EmbeddingPort, IndexingRepository } from './indexing.ports';
import { IndexingService, assertProviderCompatible } from './indexing.service';
import { MemoryVectorIndexAdapter } from '@rag/persistence-milvus';
import type { EmbeddingProfile, IndexingRun, SpaceManifest } from '@rag/contracts';

const profile: EmbeddingProfile = {
  profileId: 'fixture-v1',
  providerProfile: 'test',
  provider: 'fixture',
  modelId: 'fixture-model',
  revision: 'r1',
  protocolVersion: '1',
  tokenizerRevision: 'tokenizer-v1',
  denseDimension: 2,
  normalizeDense: true,
  sparseFormatVersion: null,
  documentTemplateVersion: 'document-v1',
  queryTemplateVersion: 'query-v1',
  maxInputTokens: 1024,
  maxBatchSize: 8,
};

describe('[IDX-003][IDX-005][IDX-009][IDX-011][IDX-013] IndexingService', () => {
  it('生成缺失事实、写入不可见 Manifest、对账后才调用 PG publish', async () => {
    const repository = createRepository();
    const embedding = createEmbedding();
    const service = createService(repository, embedding);

    await expect(service.process('job-1', 'worker-1')).resolves.toBe('PUBLISHED');

    expect(embedding.embedDocuments).toHaveBeenCalledTimes(1);
    expect(repository.saveEmbeddingFacts).toHaveBeenCalledTimes(1);
    expect((repository.markVerified as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (repository.publish as jest.Mock).mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(repository.publish).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'job-1',
      'worker-1',
    );
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it('相同 contentHash + Profile 复用事实，但仍保存当前 Chunk 来源关系', async () => {
    const repository = createRepository();
    repository.findEmbeddingFacts = jest.fn(async () => [fact()]);
    const embedding = createEmbedding();
    const service = createService(repository, embedding);

    await expect(service.process('job-1', 'worker-1')).resolves.toBe('PUBLISHED');

    expect(embedding.embedDocuments).not.toHaveBeenCalled();
    expect(repository.saveChunkEmbeddingReferences).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      [{ chunkId: 'chunk-1', embeddingFactId: '33333333-3333-4333-8333-333333333333' }],
      0,
      1,
    );
  });

  it('对账失败只标记当前 Run 失败，不发布 Manifest', async () => {
    const repository = createRepository();
    const vector = new MemoryVectorIndexAdapter();
    vector.lookupRecordIds = jest.fn(async () => []);
    const service = createService(repository, createEmbedding(), vector);

    await expect(service.process('job-1', 'worker-1')).resolves.toBe('FAILED');

    expect(repository.publish).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'job-1',
      'worker-1',
      'INDEX_RECONCILIATION_FAILED',
      '索引对账失败，当前线上版本保持不变',
    );
  });

  it('Provider revision/维度不匹配时 fail-closed', () => {
    expect(() =>
      assertProviderCompatible(profile, {
        provider: 'fixture',
        modelId: 'fixture-model',
        revision: 'wrong',
        protocolVersion: '1',
        tokenizerRevision: 'tokenizer-v1',
        denseDimension: 3,
        normalizeDense: true,
        sparseFormatVersion: null,
        maxInputTokens: 1024,
        maxBatchSize: 8,
        capabilities: ['query', 'document', 'dense'],
      }),
    ).toThrow(/revision, denseDimension/);
  });
});

function createService(
  repository: IndexingRepository,
  embedding: EmbeddingPort,
  vector = new MemoryVectorIndexAdapter(),
): IndexingService {
  return new IndexingService(repository, embedding, vector, {
    profile,
    requestTimeoutMs: 1000,
    overallDeadlineMs: 10_000,
    maxBatchTokens: 2048,
    maxConcurrency: 2,
    maxAttempts: 2,
    retryBaseDelayMs: 0,
    maxQueuedItems: 100,
    vectorWriteBatchSize: 10,
    vectorWriteMaxAttempts: 2,
  });
}

function createEmbedding(): EmbeddingPort & {
  embedDocuments: jest.Mock;
} {
  return {
    checkHealth: jest.fn(async () => undefined),
    getMetadata: jest.fn(async () => ({
      provider: profile.provider,
      modelId: profile.modelId,
      revision: profile.revision,
      protocolVersion: profile.protocolVersion,
      tokenizerRevision: profile.tokenizerRevision,
      denseDimension: profile.denseDimension,
      normalizeDense: profile.normalizeDense,
      sparseFormatVersion: profile.sparseFormatVersion,
      maxInputTokens: profile.maxInputTokens,
      maxBatchSize: profile.maxBatchSize,
      capabilities: ['query', 'document', 'dense'] as Array<'query' | 'document' | 'dense'>,
    })),
    embedDocuments: jest.fn(async (inputs) => ({
      outputs: inputs.map((input: { itemId: string; contentSha256: string }) => ({
        itemId: input.itemId,
        contentSha256: input.contentSha256,
        dense: [1, 0],
        sparse: null,
        modelId: profile.modelId,
        revision: profile.revision,
      })),
      failures: [],
    })),
    embedQueries: jest.fn(async () => ({ outputs: [], failures: [] })),
  };
}

function createRepository(): IndexingRepository & Record<string, jest.Mock> {
  const run = indexingRun();
  const manifest = spaceManifest();
  return {
    resolveProfileCollection: jest.fn(async () => ({
      collectionName: run.collectionName,
      aliasName: 'rag_test_active',
    })),
    beginRun: jest.fn(async () => ({
      run,
      manifest,
      members: [
        {
          manifestId: manifest.id,
          documentId: '44444444-4444-4444-8444-444444444444',
          documentVersionId: run.documentVersionId,
          contentRevision: 1,
          embeddingRevision: 1,
          vectorCount: 1,
        },
      ],
      chunks: [
        {
          chunkId: 'chunk-1',
          documentId: '44444444-4444-4444-8444-444444444444',
          documentVersionId: run.documentVersionId,
          contentRevision: 1,
          ordinal: 1,
          embeddingText: '制度标题\n正文',
          displayContent: '正文',
          tokenCount: 8,
          contentSha256: 'a'.repeat(64),
          headingPath: ['制度标题'],
          sourceLocations: [{ pageNo: 1 }],
        },
      ],
    })),
    startStep: jest.fn(async () => undefined),
    findEmbeddingFacts: jest.fn(async () => []),
    saveEmbeddingFacts: jest.fn(async () => [fact()]),
    saveChunkEmbeddingReferences: jest.fn(async () => undefined),
    markIndexed: jest.fn(async () => undefined),
    markVerified: jest.fn(async () => undefined),
    publish: jest.fn(async () => ({
      manifest: { ...manifest, status: 'ACTIVE' },
      supersededManifestId: null,
    })),
    fail: jest.fn(async () => undefined),
    recordCleanupWarning: jest.fn(async () => undefined),
    getRun: jest.fn(async () => run),
    getReconciliation: jest.fn(async () => undefined),
    listManifests: jest.fn(async () => [manifest]),
    rollback: jest.fn(async () => manifest),
    enqueueProfileRebuild: jest.fn(async () => '55555555-5555-4555-8555-555555555555'),
  } as unknown as IndexingRepository & Record<string, jest.Mock>;
}

function indexingRun(): IndexingRun {
  const now = new Date().toISOString();
  return {
    id: '11111111-1111-4111-8111-111111111111',
    jobId: 'job-1',
    spaceId: '66666666-6666-4666-8666-666666666666',
    documentVersionId: '77777777-7777-4777-8777-777777777777',
    contentRevision: 1,
    embeddingRevision: 1,
    providerProfile: 'test',
    embeddingProfileId: profile.profileId,
    embeddingModelId: profile.modelId,
    embeddingModelRevision: profile.revision,
    collectionName: 'rag_test_1234',
    manifestId: '22222222-2222-4222-8222-222222222222',
    manifestVersion: 1,
    status: 'BUILDING',
    expectedVectorCount: 1,
    embeddedCount: 0,
    reusedCount: 0,
    indexedCount: 0,
    failureCode: null,
    failureMessage: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function spaceManifest(): SpaceManifest {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    spaceId: '66666666-6666-4666-8666-666666666666',
    version: 1,
    status: 'BUILDING',
    providerProfile: 'test',
    embeddingProfileId: profile.profileId,
    embeddingModelId: profile.modelId,
    embeddingModelRevision: profile.revision,
    tokenizerRevision: profile.tokenizerRevision,
    denseDimension: 2,
    normalizeDense: true,
    sparseFormatVersion: null,
    collectionName: 'rag_test_1234',
    expectedVectorCount: 1,
    actualVectorCount: 0,
    reconciliationSha256: null,
    activatedAt: null,
    createdAt: new Date().toISOString(),
  };
}

function fact(): EmbeddingFact {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    embeddingProfileId: profile.profileId,
    contentSha256: 'a'.repeat(64),
    dense: [1, 0],
    sparse: null,
    modelId: profile.modelId,
    modelRevision: profile.revision,
  };
}
