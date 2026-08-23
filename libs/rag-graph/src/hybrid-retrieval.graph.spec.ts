/** 查询规划与混合检索 LangGraph 分支、混合降级与二轮上限测试。 */
import type {
  AuthorizationService,
  EmbeddingPort,
  QueryRewritePort,
  AccessContext,
  RetrievalCachePort,
  RetrievalSourceRepository,
  RetrievalTelemetryPort,
  VectorIndexPort,
} from '@rag/application';
import { createTestUserContext } from '@rag/testing';
import type { RagRun, RetrievalCandidate } from '@rag/contracts';
import {
  createHybridRetrievalGraph,
  HybridRetrievalService,
  type HybridRetrievalGraphInput,
  type HybridRetrievalGraphDependencies,
} from './hybrid-retrieval.graph';

const manifest = {
  spaceId: '11111111-1111-4111-8111-111111111111',
  manifestId: '22222222-2222-4222-8222-222222222222',
  manifestVersion: 1,
  embeddingProfileId: 'embedding-v1',
  embeddingModelRevision: 'r1',
  collectionName: 'rag_chunks_v1',
  authzPolicyVersion: 1,
};
const profile = {
  profileId: 'embedding-v1',
  initialTopK: 40,
  finalTopK: 12,
  rrfK: 60,
  denseWeight: 0.65,
  sparseWeight: 0.35,
  maxPerDocument: 3,
  maxPerSection: 2,
  minimumResults: 2,
  maxRounds: 2 as const,
};

describe('[RET-009][RET-015] 查询规划与混合检索 LangGraph', () => {
  test('实际编译图执行 Dense/Sparse 并行召回、RRF、PG 回源与二轮停止', async () => {
    const source = sourceWithCandidates([]);
    const dependencies = graphDependencies(source);
    const graph = createHybridRetrievalGraph(dependencies);
    const result = await graph.invoke(initialState('制度额度是多少？'));

    expect(result.route).toBe('KNOWLEDGE');
    expect(result.roundCount).toBe(2);
    expect(result.routeSummaries).toHaveLength(4);
    expect(jest.mocked(dependencies.vectorIndex.searchManifestDense)).toHaveBeenCalledTimes(2);
    expect(jest.mocked(dependencies.vectorIndex.searchManifestSparse)).toHaveBeenCalledTimes(2);
    expect(jest.mocked(source.hydrateAndRecheck)).toHaveBeenCalledTimes(2);
  });

  test('Dense 故障时 Sparse 单路线安全降级并保留真实候选', async () => {
    const source = sourceWithCandidates([candidate('a')]);
    const dependencies = graphDependencies(source, true);
    const result = await createHybridRetrievalGraph(dependencies).invoke(
      initialState('制度编码是什么？'),
    );

    expect(result.degraded).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.routeSummaries[0]).toMatchObject({ route: 'DENSE', status: 'DEGRADED' });
    expect(result.routeSummaries[1]).toMatchObject({ route: 'SPARSE', status: 'SUCCEEDED' });
  });

  test('问候路线不调用模型、Embedding 或向量库', async () => {
    const source = sourceWithCandidates([]);
    const dependencies = graphDependencies(source);
    const result = await createHybridRetrievalGraph(dependencies).invoke(initialState('你好'));
    expect(result.route).toBe('CHAT');
    expect(jest.mocked(dependencies.embedding.embedQueries)).not.toHaveBeenCalled();
    expect(jest.mocked(dependencies.vectorIndex.searchManifestDense)).not.toHaveBeenCalled();
  });
});

describe('[RET-016] 查询规划与混合检索 授权调试服务', () => {
  test('普通阅读者即使是 Run owner 也不能执行调试', async () => {
    const source = sourceWithCandidates([]);
    const service = debugService(source);
    await expect(service.debug(contextWithRole('KNOWLEDGE_READER'), runId)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect(source.loadRunInput).not.toHaveBeenCalled();
  });

  test('管理员以 Run 密文问题执行图，但响应不包含问题或正文', async () => {
    const source = sourceWithCandidates([]);
    source.loadRunInput = jest.fn(async () => ({
      run: runFact(),
      protectedQuestion: {
        storage: 'PLAIN' as const,
        value: '你好',
        sha256: 'f'.repeat(64),
      },
      historyEntities: [],
    }));
    const result = await debugService(source).debug(contextWithRole('SYSTEM_ADMIN'), runId);
    expect(result.route).toBe('CHAT');
    expect(JSON.stringify(result)).not.toContain('你好');
    expect(JSON.stringify(result)).not.toContain('displayContent');
  });
});

const runId = '77777777-7777-4777-8777-777777777777';

function debugService(source: RetrievalSourceRepository): HybridRetrievalService {
  const authorization = {
    restrictRequestedSpaces: jest.fn(
      async (_context: unknown, spaces: readonly string[]) => spaces,
    ),
  } as unknown as AuthorizationService;
  return new HybridRetrievalService(
    graphDependencies(source),
    source,
    authorization,
    { protect: jest.fn(), reveal: (value) => value.value, redacted: jest.fn() },
    { signal: () => new AbortController().signal, cancel: jest.fn(), release: jest.fn() },
  );
}

function contextWithRole(role: 'KNOWLEDGE_READER' | 'SYSTEM_ADMIN'): AccessContext {
  return {
    user: createTestUserContext('hybrid-retrieval-owner', [role]),
    requestId: 'hybrid-retrieval-debug-request',
  };
}

function runFact(): RagRun {
  const now = new Date();
  return {
    id: runId,
    conversationId: '88888888-8888-4888-8888-888888888888',
    userMessageId: '99999999-9999-4999-8999-999999999999',
    assistantMessageId: null,
    status: 'ACCEPTED' as const,
    optimisticVersion: 0,
    snapshot: {
      flowVersion: 'flow-v1',
      policyVersion: 'policy-v1',
      promptProfileId: 'prompt-v1',
      embeddingProfileId: 'embedding-v1',
      embeddingRevision: 'r1',
      rerankerProfileId: 'reranker-v1',
      rerankerRevision: 'r1',
      llmProfileId: 'llm-v1',
      llmRevision: 'r1',
      validatorProfileId: 'validator-v1',
      manifests: [manifest],
      authzVersion: 1,
      rolesSha256: 'a'.repeat(64),
      retrieval: profile,
    },
    deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
    eventExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    cancelRequestedAt: null,
    failureCode: null,
    publicMessage: '已接收',
    createdAt: now.toISOString(),
    startedAt: null,
    completedAt: null,
    updatedAt: now.toISOString(),
  };
}

function graphDependencies(
  source: RetrievalSourceRepository,
  denseFails = false,
): HybridRetrievalGraphDependencies {
  const embedQueries: jest.MockedFunction<EmbeddingPort['embedQueries']> = jest.fn(
    async (inputs, options) => {
      void options;
      return {
        outputs: inputs.map((input) => ({
          itemId: input.itemId,
          contentSha256: input.contentSha256,
          dense: [1, 0],
          sparse: { indices: [1, 2], values: [1, 0.5] },
          modelId: 'model-v1',
          revision: 'r1',
        })),
        failures: [],
      };
    },
  );
  const embedding = {
    embedQueries,
  } as unknown as EmbeddingPort;
  const hit = {
    vectorId: 'a'.repeat(64),
    documentId: '33333333-3333-4333-8333-333333333333',
    score: 0.9,
  };
  const searchManifestDense: jest.MockedFunction<VectorIndexPort['searchManifestDense']> = jest.fn(
    async (collection, manifestId, dense, limit, options) => {
      void collection;
      void manifestId;
      void dense;
      void limit;
      void options;
      if (denseFails) throw new Error('dense unavailable');
      return [hit];
    },
  );
  const searchManifestSparse: jest.MockedFunction<VectorIndexPort['searchManifestSparse']> =
    jest.fn(async (collection, manifestId, sparse, limit, options) => {
      void collection;
      void manifestId;
      void sparse;
      void limit;
      void options;
      return [hit];
    });
  const vectorIndex = { searchManifestDense, searchManifestSparse } as unknown as VectorIndexPort;
  const rewrite = {
    rewrite: jest.fn(async (input) => ({
      rewrittenQuery: input.question,
      subQuestions: [input.question],
      entities: [],
    })),
  } as QueryRewritePort;
  const cache = {
    getQueryEmbedding: jest.fn(async () => undefined),
    setQueryEmbedding: jest.fn(async () => undefined),
  } as RetrievalCachePort;
  return {
    rewrite,
    embedding,
    vectorIndex,
    cache,
    source,
    telemetry: noOpTelemetry(),
    embeddingRequestTimeoutMs: 1_000,
    vectorRequestTimeoutMs: 1_000,
    llmRequestTimeoutMs: 1_000,
    embeddingMaxInputTokens: 8_192,
    queryCacheTtlSeconds: 600,
    expectedEmbeddingRevision: 'r1',
    expectedEmbeddingModelId: 'model-v1',
    expectedEmbeddingDimension: 2,
  };
}

function sourceWithCandidates(hydrated: readonly RetrievalCandidate[]): RetrievalSourceRepository {
  const hydrateAndRecheck: jest.MockedFunction<RetrievalSourceRepository['hydrateAndRecheck']> =
    jest.fn(async (_context, command) => {
      const removedByReason: Readonly<Record<string, number>> =
        hydrated.length === 0 && command.candidates.length > 0
          ? { SOURCE_RECHECK_FAILED: command.candidates.length }
          : {};
      return {
        candidates: hydrated.map((item) => ({
          ...item,
          ...(command.candidates.find((candidate) => candidate.vectorId === item.vectorId) ?? {}),
        })),
        removedByReason,
      };
    });
  return {
    loadRunInput: jest.fn(),
    hydrateAndRecheck,
  };
}

function initialState(question: string): HybridRetrievalGraphInput {
  return {
    runId: '77777777-7777-4777-8777-777777777777',
    context: {
      user: createTestUserContext('hybrid-retrieval-user', ['SYSTEM_ADMIN']),
      requestId: 'hybrid-retrieval-request',
    },
    question,
    historyEntities: [],
    manifests: [manifest],
    allowedSpaceIds: [manifest.spaceId],
    profile,
    authScopeSha256: 'b'.repeat(64),
    asOf: new Date('2026-08-24T00:00:00.000Z'),
    deadlineAt: new Date(Date.now() + 10_000),
    signal: new AbortController().signal,
  };
}

function candidate(id: string): RetrievalCandidate {
  return {
    vectorId: id.repeat(64),
    manifestId: manifest.manifestId,
    spaceId: manifest.spaceId,
    documentId: '33333333-3333-4333-8333-333333333333',
    denseRank: 1,
    sparseRank: 1,
    denseScore: 0.9,
    sparseScore: 0.9,
    rrfScore: 0.02,
    chunkId: 'chunk-a',
    documentVersionId: '44444444-4444-4444-8444-444444444444',
    contentRevision: 1,
    ordinal: 1,
    title: '差旅制度',
    headingPath: ['报销额度'],
    displayContent: '差旅报销额度为 5000 元。',
    sourceLocations: [],
    publishedAt: '2026-08-01T00:00:00.000Z',
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    effectiveTo: null,
  };
}

function noOpTelemetry(): RetrievalTelemetryPort {
  return {
    route: () => undefined,
    cache: () => undefined,
    retrievalRoute: () => undefined,
    removed: () => undefined,
    stage: () => undefined,
  };
}
