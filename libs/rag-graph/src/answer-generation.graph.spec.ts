/**
 * 答案 LangGraph 的端到端纯端口测试。
 *
 * 测试不连接公网模型或数据库，重点验证路由无法被 LLM 绕过、引用复核发生在发布前，且
 * Reranker 故障只在显式允许时降级。
 *
 * @requirement ANS-002
 * @requirement ANS-005
 * @requirement ANS-011
 * @requirement ANS-015
 * @requirement ANS-020
 */
import type {
  AnswerGenerationTelemetryPort,
  AnswerModelPort,
  EvidenceSourceRepository,
  GenerateAnswerDraftInput,
  LlmEvidenceRerankInput,
  RerankerPort,
} from '@rag/application';
import type { EvidenceSource, RagRun, RetrievalCandidate } from '@rag/contracts';
import { createTestUserContext } from '@rag/testing';
import {
  createAnswerGenerationGraph,
  type AnswerGenerationGraphDependencies,
  type AnswerGenerationGraphInput,
} from './answer-generation.graph';
import type { HybridRetrievalService } from './hybrid-retrieval.graph';
import degradationGolden from '../../../test/fixtures/answer-generation/golden-answer-degradations.json';

const spaceId = '11111111-1111-4111-8111-111111111111';
const manifestId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const versionId = '44444444-4444-4444-8444-444444444444';
const runId = '55555555-5555-4555-8555-555555555555';

describe('[ANS-020] answer generation graph', () => {
  it('只在引用最终复核通过后产生 ANSWERED', async () => {
    const dependencies = fixtures('KNOWLEDGE');
    const graph = createAnswerGenerationGraph(dependencies);
    const state = await graph.invoke(input());

    expect(state.finalAnswer).toMatchObject({ status: 'ANSWERED' });
    expect(state.finalAnswer?.citations).toHaveLength(1);
    expect(dependencies.evidenceSource.revalidateSources).toHaveBeenCalledTimes(1);
    expect(dependencies.model.generateDraft).toHaveBeenCalledTimes(1);
  });

  it('CLARIFY 路由不会调用生成模型', async () => {
    const dependencies = fixtures('CLARIFY');
    const graph = createAnswerGenerationGraph(dependencies);
    const state = await graph.invoke(input());

    expect(state.finalAnswer).toMatchObject({ status: 'CLARIFICATION', claims: [] });
    expect(dependencies.model.generateDraft).not.toHaveBeenCalled();
  });

  it('专用 Reranker 超时在策略允许时降级但仍经过 Validator', async () => {
    const dependencies = fixtures('KNOWLEDGE');
    (dependencies.reranker.rerank as jest.Mock).mockRejectedValueOnce({ code: 'TIMEOUT' });
    const state = await createAnswerGenerationGraph(dependencies).invoke(input());

    expect(state.degraded).toBe(true);
    expect(dependencies.telemetry.degradation).toHaveBeenCalledWith('RERANKER_UNAVAILABLE');
    expect(state.finalAnswer?.validation.outcome).toBe('PASS');
  });

  it('Reranker revision 错配不能被 fallback 掩盖', async () => {
    const dependencies = fixtures('KNOWLEDGE');
    dependencies.reranker.rerank.mockResolvedValueOnce({
      modelId: 'fixture-reranker',
      revision: 'wrong-revision',
      scores: [{ candidateId: 'chunk-answer-1', score: 0.9, rank: 1 }],
    });
    await expect(createAnswerGenerationGraph(dependencies).invoke(input())).rejects.toThrow(
      /RERANKER_SNAPSHOT_MISMATCH/,
    );
  });

  it.each(degradationGolden)('$name -> $reason', async ({ kind, reason }) => {
    const dependencies = fixtures('KNOWLEDGE');
    let graphDependencies: AnswerGenerationGraphDependencies = dependencies;
    if (kind === 'RERANKER_FAILURE') {
      dependencies.reranker.rerank.mockRejectedValueOnce({ code: 'TIMEOUT' });
    } else {
      graphDependencies = {
        ...dependencies,
        config: {
          ...dependencies.config,
          minimumConfidence: 1,
          llmEvidenceRerankEnabled: kind !== 'LLM_DISABLED',
        },
      };
      if (kind === 'LLM_FAILURE') {
        dependencies.model.rerankEvidence.mockRejectedValueOnce(new Error('upstream'));
      }
    }
    const state = await createAnswerGenerationGraph(graphDependencies).invoke(input());
    expect(state.degraded).toBe(true);
    expect(dependencies.telemetry.degradation).toHaveBeenCalledWith(reason);
  });
});

function input(): AnswerGenerationGraphInput {
  return {
    runId,
    context: {
      user: createTestUserContext('reader-1', ['KNOWLEDGE_READER']),
      requestId: 'req-answer-test',
    },
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + 60_000),
  };
}

function fixtures(route: 'KNOWLEDGE' | 'CLARIFY'): AnswerGenerationGraphDependencies & {
  reranker: jest.Mocked<RerankerPort>;
  evidenceSource: jest.Mocked<EvidenceSourceRepository>;
  model: jest.Mocked<AnswerModelPort>;
  telemetry: jest.Mocked<AnswerGenerationTelemetryPort>;
} {
  const run = runFixture();
  const candidate = candidateFixture();
  const retrieval = {
    retrieve: jest.fn().mockResolvedValue({
      question: '报销制度是什么？',
      run,
      allowedSpaceIds: [spaceId],
      route,
      ...(route === 'KNOWLEDGE'
        ? {
            plan: {
              subQuestions: ['报销制度是什么？'],
            },
          }
        : {}),
      candidates: route === 'KNOWLEDGE' ? [candidate] : [],
      roundCount: route === 'KNOWLEDGE' ? 1 : 0,
      cacheHit: false,
      degraded: false,
      routeSummaries: [],
      removedByReason: {},
      exactLiteralKinds: [],
      terminalPlanSha256: 'a'.repeat(64),
    }),
  } as unknown as HybridRetrievalService;
  const reranker: jest.Mocked<RerankerPort> = {
    checkHealth: jest.fn().mockResolvedValue(undefined),
    getMetadata: jest.fn(),
    rerank: jest.fn().mockResolvedValue({
      modelId: 'fixture-reranker',
      revision: '1',
      scores: [{ candidateId: candidate.chunkId, score: 0.98, rank: 1 }],
    }),
  };
  const evidenceSource: jest.Mocked<EvidenceSourceRepository> = {
    expandAndRecheck: jest.fn().mockResolvedValue({
      materials:
        route === 'KNOWLEDGE'
          ? [
              {
                relation: 'SELF',
                originCandidateId: candidate.chunkId,
                manifestId,
                spaceId,
                documentId,
                documentVersionId: versionId,
                contentRevision: 1,
                chunkId: candidate.chunkId,
                title: '员工报销制度',
                headingPath: ['适用范围'],
                content: '员工应按当前报销制度提交有效凭证。',
                sourceLocations: [{ pageNo: 1 }],
                publishedAt: '2026-08-01T00:00:00.000Z',
                effectiveFrom: '2026-08-01T00:00:00.000Z',
                effectiveTo: null,
              },
            ]
          : [],
      removedByReason: {},
    }),
    revalidateSources: jest
      .fn()
      .mockImplementation((_context, sources: readonly EvidenceSource[]) =>
        Promise.resolve(sources.map((source) => source.sourceId)),
      ),
  };
  const model: jest.Mocked<AnswerModelPort> = {
    generateDraft: jest.fn().mockImplementation((value: GenerateAnswerDraftInput) =>
      Promise.resolve({
        summary: '员工应遵循现行报销制度。',
        claims: [
          {
            claimId: 'claim-1',
            kind: 'FACT',
            text: '员工应提交有效凭证。',
            sourceIds: [value.context.includedSourceIds[0]!],
            calculationId: null,
            supportMode: 'DIRECT',
          },
        ],
        caveats: [],
        followUpQuestion: null,
      }),
    ),
    rerankEvidence: jest.fn().mockImplementation((value: LlmEvidenceRerankInput) =>
      Promise.resolve({
        orderedSourceIds: value.bundle.sources.map((source) => source.sourceId),
        reason: 'test',
      }),
    ),
    judgeGrounding: jest.fn(),
  };
  const telemetry: jest.Mocked<AnswerGenerationTelemetryPort> = {
    route: jest.fn(),
    validation: jest.fn(),
    degradation: jest.fn(),
    stage: jest.fn(),
  };
  return {
    retrieval,
    reranker,
    evidenceSource,
    model,
    telemetry,
    config: {
      rerankerTimeoutMs: 1_000,
      llmTimeoutMs: 1_000,
      rerankerMaximumCandidates: 20,
      rerankerTopN: 10,
      rerankFallbackEnabled: true,
      llmEvidenceRerankEnabled: true,
      semanticJudgeEnabled: true,
      contextTokenBudget: 4_000,
      contextMaximumPerDocument: 2,
      minimumConfidence: 0.58,
      validatorProfileId: 'validator-v1',
      expectedRerankerRevision: '1',
    },
  };
}

function runFixture(): RagRun {
  return {
    id: runId,
    conversationId: '66666666-6666-4666-8666-666666666666',
    userMessageId: '77777777-7777-4777-8777-777777777777',
    assistantMessageId: null,
    status: 'RUNNING',
    optimisticVersion: 1,
    snapshot: {
      flowVersion: 'answer-v1',
      policyVersion: 'policy-v1',
      promptProfileId: 'prompt-v1',
      embeddingProfileId: 'embedding-v1',
      embeddingRevision: '1',
      rerankerProfileId: 'reranker-v1',
      rerankerRevision: '1',
      llmProfileId: 'llm-v1',
      llmRevision: '1',
      validatorProfileId: 'validator-v1',
      manifests: [
        {
          spaceId,
          manifestId,
          manifestVersion: 1,
          embeddingProfileId: 'embedding-v1',
          embeddingModelRevision: '1',
          collectionName: 'rag_chunks_v1',
          authzPolicyVersion: 1,
        },
      ],
      authzVersion: 1,
      rolesSha256: 'a'.repeat(64),
      retrieval: {
        profileId: 'hybrid-v1',
        initialTopK: 20,
        finalTopK: 10,
        rrfK: 60,
        denseWeight: 0.65,
        sparseWeight: 0.35,
        maxPerDocument: 3,
        maxPerSection: 2,
        minimumResults: 1,
        maxRounds: 2,
      },
    },
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    eventExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    cancelRequestedAt: null,
    failureCode: null,
    publicMessage: '正在执行',
    createdAt: '2026-08-23T00:00:00.000Z',
    startedAt: '2026-08-23T00:00:01.000Z',
    completedAt: null,
    updatedAt: '2026-08-23T00:00:01.000Z',
  };
}

function candidateFixture(): RetrievalCandidate {
  return {
    vectorId: 'b'.repeat(64),
    manifestId,
    spaceId,
    documentId,
    denseRank: 1,
    sparseRank: 1,
    denseScore: 0.9,
    sparseScore: 0.8,
    rrfScore: 0.1,
    chunkId: 'chunk-answer-1',
    documentVersionId: versionId,
    contentRevision: 1,
    ordinal: 1,
    title: '员工报销制度',
    headingPath: ['适用范围'],
    displayContent: '员工应按当前报销制度提交有效凭证。',
    sourceLocations: [{ pageNo: 1 }],
    publishedAt: '2026-08-01T00:00:00.000Z',
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    effectiveTo: null,
  };
}
