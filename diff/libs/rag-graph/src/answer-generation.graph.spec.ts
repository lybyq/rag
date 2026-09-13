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
  RagRunLifecycleService,
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
import diagnosticBaseline from '../../../test/fixtures/answer-generation/intranet-diagnostic-baseline.json';
import { AnswerGenerationExecutionService } from './answer-generation.execution.service';

const spaceId = '11111111-1111-4111-8111-111111111111';
const manifestId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const versionId = '44444444-4444-4444-8444-444444444444';
const runId = '55555555-5555-4555-8555-555555555555';

describe('[ANS-020] answer generation graph', () => {
  it('[OPT-004] 首轮候选在 Evidence 回源后失效时真正执行受限第二轮再回答', async () => {
    const dependencies = fixtures('KNOWLEDGE');
    const firstExpanded = await dependencies.evidenceSource.expandAndRecheck(
      {} as never,
      {} as never,
    );
    dependencies.evidenceSource.expandAndRecheck
      .mockResolvedValueOnce({ materials: [], removedByReason: { SOURCE_RECHECK_FAILED: 1 } })
      .mockResolvedValueOnce(firstExpanded);

    const state = await createAnswerGenerationGraph(dependencies).invoke(input());

    expect(dependencies.retrieval.retryAfterEvidenceFailure).toHaveBeenCalledTimes(1);
    expect(dependencies.reranker.rerank).toHaveBeenCalledTimes(2);
    expect(dependencies.evidenceSource.expandAndRecheck).toHaveBeenCalledTimes(3);
    expect(state.retrieval?.roundCount).toBe(2);
    expect(state.finalAnswer?.status).toBe('ANSWERED');
  });

  it('[OPT-001] 节点模型逻辑调用数区分专用重排、生成与被关闭的可选调用', async () => {
    const dependencies = fixtures('KNOWLEDGE');
    const audit = { start: jest.fn(), finish: jest.fn() };
    await createAnswerGenerationGraph({
      ...dependencies,
      audit,
      config: { ...dependencies.config, minimumConfidence: 1, llmEvidenceRerankEnabled: false },
    }).invoke(input());
    const summary = (node: string): unknown =>
      audit.finish.mock.calls.find((call) => call[1] === node)?.[4];
    expect(summary('answer_rerank')).toMatchObject({ logicalModelCallCount: 1 });
    expect(summary('answer_generate_draft')).toMatchObject({ logicalModelCallCount: 1 });
    expect(summary('answer_llm_evidence_rerank')).toMatchObject({ logicalModelCallCount: 0 });
  });

  it('[OPT-001] 材料复核失败仅暴露固定原因，不暴露被拒文档数量或私有原因键', async () => {
    const dependencies = fixtures('KNOWLEDGE');
    const audit = { start: jest.fn(), finish: jest.fn() };
    dependencies.evidenceSource.expandAndRecheck.mockResolvedValue({
      materials: [],
      removedByReason: { SOURCE_RECHECK_FAILED: 8, 'private-document-name': 99 },
    });
    await createAnswerGenerationGraph({ ...dependencies, audit }).invoke(input());
    const summary = audit.finish.mock.calls.find(
      (call) => call[1] === 'answer_expand_evidence',
    )?.[4];
    expect(summary).toMatchObject({
      materialRemovalReasons: ['SOURCE_RECHECK_FAILED', 'OTHER'],
      accessibleDocumentCount: 0,
    });
    expect(JSON.stringify(summary)).not.toMatch(/private-document-name|99/);
  });

  it('[OPT-001] 实际执行服务把白名单错误同时传到步骤顶层和摘要，终态仍为运行失败', async () => {
    const dependencies = fixtures('KNOWLEDGE');
    dependencies.model.generateDraft.mockRejectedValue({
      code: 'TIMEOUT',
      message: 'private-content',
    });
    const run = runFixture();
    const lifecycle = {
      start: jest.fn().mockResolvedValue({ run, signal: new AbortController().signal }),
      startStep: jest.fn(),
      finishStep: jest.fn(),
      fail: jest.fn().mockResolvedValue({ ...run, status: 'FAILED' }),
      complete: jest.fn(),
    };
    const service = new AnswerGenerationExecutionService(
      dependencies,
      lifecycle as unknown as RagRunLifecycleService,
      { llmModelId: 'test-model' },
    );
    const result = await service.execute(input().context, {
      run,
      ownerUserId: 'reader-1',
    } as Parameters<typeof service.execute>[1]);
    expect(result.status).toBe('FAILED');
    expect(lifecycle.finishStep).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        nodeKey: 'answer_generate_draft',
        status: 'FAILED',
        errorCode: 'TIMEOUT',
        outputSummary: expect.objectContaining({ errorCode: 'TIMEOUT' }),
      }),
    );
    expect(lifecycle.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(lifecycle.finishStep.mock.calls)).not.toContain('private-content');
  });

  it.each(diagnosticBaseline)(
    '[OPT-001] $id $title / $scenario',
    async ({ question, title, content, scenario }) => {
      const dependencies = fixtures('KNOWLEDGE');
      const audit = { start: jest.fn(), finish: jest.fn() };
      const retrievalMock = dependencies.retrieval.retrieve as jest.Mock;
      const retrieval = await retrievalMock();
      retrievalMock.mockResolvedValue({
        ...retrieval,
        question,
        plan: { ...retrieval.plan, subQuestions: [question] },
      });
      const expanded = await dependencies.evidenceSource.expandAndRecheck({} as never, {} as never);
      dependencies.evidenceSource.expandAndRecheck.mockResolvedValue({
        ...expanded,
        materials:
          scenario === 'NO_MATERIAL'
            ? []
            : expanded.materials.map((material) => ({ ...material, title, content })),
      });
      dependencies.model.generateDraft.mockImplementation(async (request) => ({
        summary: content,
        claims: [
          {
            claimId: 'claim-1',
            kind: 'FACT',
            text: content,
            sourceIds: [request.context.includedSourceIds[0]!],
            calculationId: null,
            supportMode: 'DIRECT',
          },
        ],
        caveats: [],
        followUpQuestion: null,
      }));
      if (scenario === 'REVOKED')
        dependencies.evidenceSource.revalidateSources.mockResolvedValue([]);
      if (scenario === 'TIMEOUT')
        dependencies.model.generateDraft.mockRejectedValue({ code: 'TIMEOUT' });
      const execution = createAnswerGenerationGraph({ ...dependencies, audit }).invoke(input());
      if (scenario === 'TIMEOUT') {
        await expect(execution).rejects.toMatchObject({ code: 'TIMEOUT' });
      } else {
        const state = await execution;
        expect(state.finalAnswer?.status).toBe(scenario === 'ANSWERED' ? 'ANSWERED' : 'REJECTED');
        if (scenario === 'NO_MATERIAL')
          expect(dependencies.model.generateDraft).not.toHaveBeenCalled();
        if (scenario === 'REVOKED')
          expect(state.validation?.issues.map((issue) => issue.code)).toContain(
            'CITATION_REVALIDATION_FAILED',
          );
      }
      const summaries = JSON.stringify(audit.finish.mock.calls);
      expect(summaries).not.toContain(question);
      expect(summaries).not.toContain(content);
    },
  );

  it('[OPT-001] 阶段审计保留真实上下文计数和耗时，不包含问题、标题或正文', async () => {
    const dependencies = fixtures('KNOWLEDGE');
    const audit = { start: jest.fn(), finish: jest.fn() };
    await createAnswerGenerationGraph({ ...dependencies, audit }).invoke(input());
    const context = audit.finish.mock.calls.find((call) => call[1] === 'answer_build_context');
    expect(context?.[4]).toMatchObject({
      contextIncludedCount: 1,
      contextOmittedCount: 0,
      durationMs: expect.any(Number),
    });
    const generated = audit.finish.mock.calls.find((call) => call[1] === 'answer_generate_draft');
    expect(generated?.[4]).toMatchObject({ generationAttempt: 1 });
    expect(JSON.stringify(audit.finish.mock.calls)).not.toMatch(/报销制度|有效凭证/);
  });

  it.each(['TIMEOUT', 'SCHEMA_ERROR', 'AUTHENTICATION', 'UPSTREAM_5XX'])(
    '[OPT-001] 保留允许的故障分类 %s 而不记录远端消息',
    async (code) => {
      const dependencies = fixtures('KNOWLEDGE');
      const audit = { start: jest.fn(), finish: jest.fn() };
      dependencies.model.generateDraft.mockRejectedValueOnce({
        code,
        message: 'secret-provider-content',
      });
      await expect(
        createAnswerGenerationGraph({ ...dependencies, audit }).invoke(input()),
      ).rejects.toBeDefined();
      expect(audit.finish).toHaveBeenCalledWith(
        runId,
        'answer_generate_draft',
        1,
        'FAILED',
        expect.objectContaining({ errorCode: code, durationMs: expect.any(Number) }),
      );
      expect(JSON.stringify(audit.finish.mock.calls)).not.toContain('secret-provider-content');
    },
  );

  it('[OPT-001] 未知错误码可能携带正文，只写固定 UNKNOWN', async () => {
    const dependencies = fixtures('KNOWLEDGE');
    const audit = { start: jest.fn(), finish: jest.fn() };
    dependencies.model.generateDraft.mockRejectedValueOnce({ code: 'secret-question' });
    await expect(
      createAnswerGenerationGraph({ ...dependencies, audit }).invoke(input()),
    ).rejects.toBeDefined();
    expect(audit.finish).toHaveBeenCalledWith(
      runId,
      'answer_generate_draft',
      1,
      'FAILED',
      expect.objectContaining({ errorCode: 'UNKNOWN' }),
    );
    expect(JSON.stringify(audit.finish.mock.calls)).not.toContain('secret-question');
  });

  it('只在引用最终复核通过后产生 ANSWERED', async () => {
    const dependencies = fixtures('KNOWLEDGE');
    const graph = createAnswerGenerationGraph(dependencies);
    const state = await graph.invoke(input());

    expect(state.finalAnswer).toMatchObject({ status: 'ANSWERED' });
    expect(state.finalAnswer?.citations).toHaveLength(1);
    expect(dependencies.evidenceSource.revalidateSources).toHaveBeenCalledTimes(1);
    expect(dependencies.model.generateDraft).toHaveBeenCalledTimes(1);
  });

  it.each([
    { llmRerank: false, judge: false, semanticClaim: false, rerankCalls: 0, judgeCalls: 0 },
    { llmRerank: true, judge: false, semanticClaim: false, rerankCalls: 1, judgeCalls: 0 },
    { llmRerank: false, judge: true, semanticClaim: true, rerankCalls: 0, judgeCalls: 1 },
    { llmRerank: true, judge: true, semanticClaim: true, rerankCalls: 1, judgeCalls: 1 },
  ])(
    '[OPT-005] 双开关 llm=$llmRerank judge=$judge 只执行必要模型调用',
    async ({ llmRerank, judge, semanticClaim, rerankCalls, judgeCalls }) => {
      const dependencies = fixtures('KNOWLEDGE');
      const graphDependencies: AnswerGenerationGraphDependencies = {
        ...dependencies,
        config: {
          ...dependencies.config,
          minimumConfidence: 1,
          llmEvidenceRerankEnabled: llmRerank,
          semanticJudgeEnabled: judge,
        },
      };
      if (semanticClaim) {
        dependencies.model.generateDraft.mockImplementation(async (request) => ({
          summary: '员工应提交有效凭证。',
          claims: [
            {
              claimId: 'claim-1',
              kind: 'FACT',
              text: '员工应提交有效凭证。',
              sourceIds: [request.context.includedSourceIds[0]!],
              calculationId: null,
              supportMode: 'SEMANTIC',
            },
          ],
          caveats: [],
          followUpQuestion: null,
        }));
        dependencies.model.judgeGrounding.mockResolvedValue({
          modelId: 'fixture-llm',
          revision: '1',
          reason: 'test',
          supportedClaimIds: ['claim-1'],
          unsupportedClaimIds: [],
        });
      }

      const state = await createAnswerGenerationGraph(graphDependencies).invoke(input());

      expect(state.finalAnswer?.status).toBe('ANSWERED');
      expect(dependencies.model.rerankEvidence).toHaveBeenCalledTimes(rerankCalls);
      expect(dependencies.model.judgeGrounding).toHaveBeenCalledTimes(judgeCalls);
      expect(dependencies.model.generateDraft).toHaveBeenCalledTimes(1);
      expect(dependencies.model.generateDraft).toHaveBeenCalledWith(
        expect.objectContaining({ directEvidenceOnly: !judge }),
        expect.any(Object),
      );
    },
  );

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
  const retrievalResult = {
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
  };
  const retrieval = {
    retrieve: jest.fn().mockResolvedValue(retrievalResult),
    retryAfterEvidenceFailure: jest
      .fn()
      .mockImplementation((_context: unknown, _runId: string, previous: typeof retrievalResult) =>
        Promise.resolve({ ...previous, roundCount: 2 }),
      ),
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
