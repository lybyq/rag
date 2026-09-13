/**
 * 证据、生成与答案校验 LangGraph 工作流。
 *
 * 该图把混合检索作为受控子图复用，然后依次执行专用 Reranker、PG 证据扩展、Evidence
 * Router、注入安全上下文、结构化生成、引用再鉴权、确定性 Validator、必要时 Semantic
 * Judge 和最多一次修复生成。客户端只能看到阶段事件；正文与引用只由 FinalAnswer 输出。
 *
 * @requirement ANS-002
 * @requirement ANS-003
 * @requirement ANS-005
 * @requirement ANS-006
 * @requirement ANS-009
 * @requirement ANS-014
 * @requirement ANS-015
 */
import { END, START, StateGraph, StateSchema, type GraphNode } from '@langchain/langgraph';
import {
  type AccessContext,
  type AnswerGenerationTelemetryPort,
  type AnswerModelPort,
  type EvidenceSourceRepository,
  type ExpandedEvidenceMaterial,
  type ProviderCallOptions,
  type RerankerPort,
} from '@rag/application';
import { finalizeAnswer, semanticClaimIds, validateAnswer } from '@rag/answer';
import type {
  AnswerContext,
  AnswerDraft,
  DeterministicCalculation,
  EvidenceBundle,
  EvidenceRoute,
  FinalAnswer,
  RagRun,
  RerankScore,
  RetrievalCandidate,
  SemanticGroundingReport,
  ValidationReport,
} from '@rag/contracts';
import {
  buildAnswerContext,
  buildEvidenceBundle,
  calculateDeterministicFacts,
  evidenceBundleForAnswerContext,
  routeEvidence,
} from '@rag/evidence';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';
import type { HybridRetrievalResult, HybridRetrievalService } from './hybrid-retrieval.graph';
import { answerDiagnosticErrorCode } from './answer-diagnostics';

const AnswerGenerationState = new StateSchema({
  runId: z.string(),
  context: z.custom<AccessContext>(),
  signal: z.custom<AbortSignal>(),
  deadlineAt: z.date(),
  retrieval: z.custom<HybridRetrievalResult>().optional(),
  run: z.custom<RagRun>().optional(),
  question: z.string().default(''),
  candidates: z.custom<readonly RetrievalCandidate[]>().default(() => []),
  rerankScores: z.custom<readonly RerankScore[]>().default(() => []),
  rerankerIdentity: z.custom<Readonly<{ modelId: string; revision: string }>>().optional(),
  materials: z.custom<readonly ExpandedEvidenceMaterial[]>().default(() => []),
  bundle: z.custom<EvidenceBundle>().optional(),
  route: z.custom<EvidenceRoute>().optional(),
  llmRerankUsed: z.boolean().default(false),
  answerContext: z.custom<AnswerContext>().optional(),
  calculations: z.custom<readonly DeterministicCalculation[]>().default(() => []),
  draft: z.custom<AnswerDraft>().optional(),
  generationAttempt: z.number().int().min(0).max(2).default(0),
  currentlyValidSourceIds: z.array(z.string()).default(() => []),
  semanticJudge: z.custom<SemanticGroundingReport>().optional(),
  validation: z.custom<ValidationReport>().optional(),
  finalAnswer: z.custom<FinalAnswer>().optional(),
  degraded: z.boolean().default(false),
  /** OPT-001：本节点发起的模型 Port 调用次数，不包含 Adapter 内部 HTTP 重试。 */
  logicalModelCallCount: z.number().int().nonnegative().optional(),
  /** OPT-001：复核失败的安全分类；不携带被拒对象身份或数量。 */
  materialRemovalReasons: z.array(z.string()).optional(),
  /** Evidence 失败后最多一次真正受限重检索，区别于生成修复次数。 */
  evidenceRetrievalRetryCount: z.number().int().min(0).max(1).default(0),
});

type AnswerGenerationStateValue = typeof AnswerGenerationState.State;

/** 图调用方必须提供的可信输入。 */
export interface AnswerGenerationGraphInput {
  readonly runId: string;
  readonly context: AccessContext;
  readonly signal: AbortSignal;
  readonly deadlineAt: Date;
}

/** 每个图节点的数据库审计边界；摘要不能包含问题或证据正文。 */
export interface AnswerGenerationStageAudit {
  start(
    runId: string,
    nodeKey: string,
    attempt: number,
    input: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  finish(
    runId: string,
    nodeKey: string,
    attempt: number,
    status: 'SUCCEEDED' | 'FAILED',
    output: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

/** 答案图策略参数；Provider 地址不属于本配置。 */
export interface AnswerGenerationGraphConfig {
  readonly rerankerTimeoutMs: number;
  readonly llmTimeoutMs: number;
  readonly rerankerMaximumCandidates: number;
  readonly rerankerTopN: number;
  readonly rerankFallbackEnabled: boolean;
  readonly llmEvidenceRerankEnabled: boolean;
  readonly semanticJudgeEnabled: boolean;
  readonly contextTokenBudget: number;
  readonly contextMaximumPerDocument: number;
  readonly minimumConfidence: number;
  readonly validatorProfileId: string;
  readonly expectedRerankerRevision: string;
}

/** 答案图依赖集合。 */
export interface AnswerGenerationGraphDependencies {
  readonly retrieval: HybridRetrievalService;
  readonly reranker: RerankerPort;
  readonly evidenceSource: EvidenceSourceRepository;
  readonly model: AnswerModelPort;
  readonly telemetry: AnswerGenerationTelemetryPort;
  readonly config: AnswerGenerationGraphConfig;
  readonly audit?: AnswerGenerationStageAudit;
}

/** 编译图的窄接口，避免向应用模块泄漏 LangGraph 泛型。 */
export interface CompiledAnswerGenerationGraph {
  invoke(input: AnswerGenerationGraphInput): Promise<AnswerGenerationStateValue>;
}

/** 构建并编译证据优先答案图。 */
export function createAnswerGenerationGraph(
  dependencies: AnswerGenerationGraphDependencies,
): CompiledAnswerGenerationGraph {
  const retrieveNode = timedNode('answer_retrieve', dependencies, async (state) => {
    const retrieval = await dependencies.retrieval.retrieve(state.context, state.runId);
    return {
      retrieval,
      run: retrieval.run,
      question: retrieval.question,
      candidates: retrieval.candidates,
      degraded: retrieval.degraded,
    };
  });

  const rerankNode = timedNode('answer_rerank', dependencies, async (state) => {
    const run = requireRun(state.run);
    const candidates = state.candidates.slice(0, dependencies.config.rerankerMaximumCandidates);
    if (candidates.length === 0) return { candidates, rerankScores: [], logicalModelCallCount: 0 };
    try {
      const response = await dependencies.reranker.rerank(
        {
          query: state.question,
          documents: candidates.map((candidate) => ({
            candidateId: candidate.chunkId,
            title: candidate.title,
            content: candidate.displayContent,
          })),
          topN: Math.min(dependencies.config.rerankerTopN, candidates.length),
        },
        providerOptions(state, dependencies.config.rerankerTimeoutMs),
      );
      if (
        response.revision !== run.snapshot.rerankerRevision ||
        response.revision !== dependencies.config.expectedRerankerRevision
      ) {
        throw new Error('RERANKER_SNAPSHOT_MISMATCH');
      }
      const candidatesById = new Map(candidates.map((candidate) => [candidate.chunkId, candidate]));
      const ordered = [...response.scores]
        .sort((left, right) => left.rank - right.rank)
        .flatMap((score) => {
          const candidate = candidatesById.get(score.candidateId);
          return candidate ? [candidate] : [];
        });
      return {
        candidates: ordered,
        rerankScores: response.scores,
        rerankerIdentity: { modelId: response.modelId, revision: response.revision },
        logicalModelCallCount: 1,
      };
    } catch (error) {
      if (state.signal.aborted) throw state.signal.reason;
      if (
        !featureEnabled(
          state,
          'ANSWER_RERANK_FALLBACK_ENABLED',
          dependencies.config.rerankFallbackEnabled,
        ) ||
        !isOperationalRerankerFailure(error)
      ) {
        throw error;
      }
      dependencies.telemetry.degradation('RERANKER_UNAVAILABLE');
      const fallback = candidates.slice(0, dependencies.config.rerankerTopN);
      return {
        candidates: fallback,
        rerankScores: fallback.map((candidate, index) => ({
          candidateId: candidate.chunkId,
          score: Math.max(0.01, 1 - index / Math.max(1, fallback.length)),
          rank: index + 1,
        })),
        degraded: true,
        logicalModelCallCount: 1,
      };
    }
  });

  const retryRetrievalNode = timedNode(
    'answer_retry_retrieval',
    dependencies,
    async (state) => {
      const retrieval = await dependencies.retrieval.retryAfterEvidenceFailure(
        state.context,
        state.runId,
        requireRetrieval(state.retrieval),
      );
      return {
        retrieval,
        run: retrieval.run,
        question: retrieval.question,
        candidates: retrieval.candidates,
        rerankScores: [],
        materials: [],
        llmRerankUsed: false,
        degraded: state.degraded || retrieval.degraded,
        evidenceRetrievalRetryCount: state.evidenceRetrievalRetryCount + 1,
      };
    },
    (state) => state.evidenceRetrievalRetryCount + 1,
  );

  const expandNode = timedNode('answer_expand_evidence', dependencies, async (state) => {
    const retrieval = requireRetrieval(state.retrieval);
    const expanded = await dependencies.evidenceSource.expandAndRecheck(state.context, {
      run: retrieval.run,
      candidates: state.candidates,
      manifests: retrieval.run.snapshot.manifests,
      currentlyAllowedSpaceIds: retrieval.allowedSpaceIds,
      asOf: new Date(retrieval.run.createdAt),
    });
    return {
      materials: expanded.materials,
      materialRemovalReasons: [
        ...new Set(
          Object.keys(expanded.removedByReason).map((reason) =>
            ['ACCESS_DENIED', 'SOURCE_RECHECK_FAILED'].includes(reason) ? reason : 'OTHER',
          ),
        ),
      ],
      degraded: state.degraded || Object.keys(expanded.removedByReason).length > 0,
    };
  });

  const bundleNode = timedNode('answer_build_evidence', dependencies, (state) => {
    const retrieval = requireRetrieval(state.retrieval);
    const bundle = buildEvidenceBundle({
      runId: state.runId,
      subQuestions: retrieval.plan?.subQuestions ?? [state.question],
      candidates: state.candidates,
      materials: state.materials,
      rerankScores: state.rerankScores,
      degraded: state.degraded,
    });
    return { bundle };
  });

  const routeNode = timedNode('answer_route_evidence', dependencies, (state) => {
    const retrieval = requireRetrieval(state.retrieval);
    const route = routeEvidence({
      retrievalRoute: retrieval.route,
      bundle: requireBundle(state.bundle),
      retrievalRoundCount: retrieval.roundCount,
      maximumRetrievalRounds: retrieval.run.snapshot.retrieval.maxRounds,
      llmRerankAlreadyUsed: state.llmRerankUsed,
      minimumConfidence: dependencies.config.minimumConfidence,
    });
    dependencies.telemetry.route(route);
    return { route };
  });

  const llmRerankNode = timedNode('answer_llm_evidence_rerank', dependencies, async (state) => {
    const bundle = requireBundle(state.bundle);
    if (
      !featureEnabled(
        state,
        'ANSWER_LLM_EVIDENCE_RERANK_ENABLED',
        dependencies.config.llmEvidenceRerankEnabled,
      )
    ) {
      dependencies.telemetry.degradation('LLM_EVIDENCE_RERANK_DISABLED');
      return { llmRerankUsed: true, degraded: true, logicalModelCallCount: 0 };
    }
    try {
      const result = await dependencies.model.rerankEvidence(
        { question: state.question, bundle },
        providerOptions(state, dependencies.config.llmTimeoutMs),
      );
      return {
        bundle: reorderBundle(bundle, result.orderedSourceIds),
        llmRerankUsed: true,
        logicalModelCallCount: 1,
      };
    } catch {
      if (state.signal.aborted) throw state.signal.reason;
      dependencies.telemetry.degradation('LLM_EVIDENCE_RERANK_FAILED');
      return { llmRerankUsed: true, degraded: true, logicalModelCallCount: 1 };
    }
  });

  const contextNode = timedNode('answer_build_context', dependencies, (state) => {
    const bundle = requireBundle(state.bundle);
    const answerContext = buildAnswerContext(bundle, {
      tokenBudget: dependencies.config.contextTokenBudget,
      maximumPerDocument: dependencies.config.contextMaximumPerDocument,
    });
    const visibleBundle = evidenceBundleForAnswerContext(bundle, answerContext);
    return {
      answerContext,
      calculations: calculateDeterministicFacts(state.question, visibleBundle),
    };
  });

  const generateNode = timedNode(
    'answer_generate_draft',
    dependencies,
    async (state) => {
      const route = requireAnswerableRoute(state.route);
      const nextAttempt = state.generationAttempt + 1;
      const draft = await dependencies.model.generateDraft(
        {
          question: state.question,
          route,
          context: requireAnswerContext(state.answerContext),
          calculations: state.calculations,
          directEvidenceOnly: !featureEnabled(
            state,
            'ANSWER_SEMANTIC_JUDGE_ENABLED',
            dependencies.config.semanticJudgeEnabled,
          ),
          ...(state.draft ? { previousDraft: state.draft } : {}),
          ...(state.validation
            ? { repairInstructions: state.validation.issues.map((issue) => issue.code) }
            : {}),
        },
        providerOptions(state, dependencies.config.llmTimeoutMs),
      );
      return {
        draft,
        generationAttempt: nextAttempt,
        semanticJudge: undefined,
        logicalModelCallCount: 1,
      };
    },
    (state) => state.generationAttempt + 1,
  );

  const revalidateNode = timedNode('answer_revalidate_citations', dependencies, async (state) => ({
    currentlyValidSourceIds: [
      ...(await dependencies.evidenceSource.revalidateSources(
        state.context,
        visibleEvidenceBundle(state).sources,
        new Date(),
      )),
    ],
  }));

  const ruleValidationNode = timedNode('answer_rule_validation', dependencies, (state) => ({
    validation: validateAnswer({
      draft: requireDraft(state.draft),
      bundle: visibleEvidenceBundle(state),
      calculations: state.calculations,
      currentlyValidSourceIds: state.currentlyValidSourceIds,
      validatorProfileId: dependencies.config.validatorProfileId,
      semanticJudgeEnabled: featureEnabled(
        state,
        'ANSWER_SEMANTIC_JUDGE_ENABLED',
        dependencies.config.semanticJudgeEnabled,
      ),
    }),
  }));

  const semanticJudgeNode = timedNode('answer_semantic_judge', dependencies, async (state) => {
    const draft = requireDraft(state.draft);
    const claimIds = semanticClaimIds(draft);
    if (
      !featureEnabled(
        state,
        'ANSWER_SEMANTIC_JUDGE_ENABLED',
        dependencies.config.semanticJudgeEnabled,
      ) ||
      claimIds.length === 0
    )
      return { logicalModelCallCount: 0 };
    const semanticJudge = await dependencies.model.judgeGrounding(
      {
        draft,
        bundle: visibleEvidenceBundle(state),
        claimIds,
        reason: 'DETERMINISTIC_RULE_CANNOT_DECIDE_SEMANTIC_SUPPORT',
      },
      providerOptions(state, dependencies.config.llmTimeoutMs),
    );
    return { semanticJudge, logicalModelCallCount: 1 };
  });

  const finalValidationNode = timedNode('answer_final_validation', dependencies, (state) => {
    let validation = validateAnswer({
      draft: requireDraft(state.draft),
      bundle: visibleEvidenceBundle(state),
      calculations: state.calculations,
      currentlyValidSourceIds: state.currentlyValidSourceIds,
      validatorProfileId: dependencies.config.validatorProfileId,
      semanticJudgeEnabled: featureEnabled(
        state,
        'ANSWER_SEMANTIC_JUDGE_ENABLED',
        dependencies.config.semanticJudgeEnabled,
      ),
      ...(state.semanticJudge ? { semanticJudge: state.semanticJudge } : {}),
    });
    // ANS-014：第二份草稿仍需修复时停止循环，绝不能把 REGENERATE 当作通过。
    if (validation.outcome === 'REGENERATE' && state.generationAttempt >= 2) {
      validation = { ...validation, outcome: 'REJECT' };
    }
    dependencies.telemetry.validation(validation.outcome);
    return { validation };
  });

  const finalizeNode = timedNode('answer_finalize', dependencies, (state) => {
    const route = requireRoute(state.route);
    const validation =
      state.validation ?? terminalValidation(route, dependencies.config.validatorProfileId);
    const finalAnswer = finalizeAnswer({
      route,
      bundle: requireBundle(state.bundle),
      validation,
      ...(state.draft ? { draft: state.draft } : {}),
    });
    return { validation, finalAnswer };
  });

  return new StateGraph(AnswerGenerationState)
    .addNode('retrieve', retrieveNode)
    .addNode('rerank', rerankNode)
    .addNode('retry_retrieval', retryRetrievalNode)
    .addNode('expand_evidence', expandNode)
    .addNode('build_evidence', bundleNode)
    .addNode('route_evidence', routeNode)
    .addNode('llm_evidence_rerank', llmRerankNode)
    .addNode('build_context', contextNode)
    .addNode('generate_draft', generateNode)
    .addNode('revalidate_citations', revalidateNode)
    .addNode('rule_validation', ruleValidationNode)
    .addNode('semantic_judge', semanticJudgeNode)
    .addNode('final_validation', finalValidationNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'rerank')
    .addEdge('rerank', 'expand_evidence')
    .addEdge('expand_evidence', 'build_evidence')
    .addEdge('build_evidence', 'route_evidence')
    .addConditionalEdges('route_evidence', (state) => {
      if (state.route === 'LLM_RERANK') return 'llm_evidence_rerank';
      if (state.route === 'REWRITE_AND_RETRY' && state.evidenceRetrievalRetryCount < 1) {
        return 'retry_retrieval';
      }
      return state.route === 'ANSWER' || state.route === 'PARTIAL_ANSWER'
        ? 'build_context'
        : 'finalize';
    })
    .addEdge('retry_retrieval', 'rerank')
    .addEdge('llm_evidence_rerank', 'route_evidence')
    .addEdge('build_context', 'generate_draft')
    .addEdge('generate_draft', 'revalidate_citations')
    .addEdge('revalidate_citations', 'rule_validation')
    .addConditionalEdges('rule_validation', (state) => {
      const validation = requireValidation(state.validation);
      const hasBlocking = validation.issues.some((issue) => issue.severity === 'BLOCKING');
      const needsSemantic = semanticClaimIds(requireDraft(state.draft)).length > 0;
      return !hasBlocking &&
        needsSemantic &&
        featureEnabled(
          state,
          'ANSWER_SEMANTIC_JUDGE_ENABLED',
          dependencies.config.semanticJudgeEnabled,
        )
        ? 'semantic_judge'
        : 'final_validation';
    })
    .addEdge('semantic_judge', 'final_validation')
    .addConditionalEdges('final_validation', (state) =>
      state.validation?.outcome === 'REGENERATE' && state.generationAttempt < 2
        ? 'generate_draft'
        : 'finalize',
    )
    .addEdge('finalize', END)
    .compile() as unknown as CompiledAnswerGenerationGraph;
}

function providerOptions(
  state: Pick<AnswerGenerationStateValue, 'signal' | 'deadlineAt'>,
  timeoutMs: number,
): ProviderCallOptions {
  return { signal: state.signal, deadlineAt: state.deadlineAt, timeoutMs };
}

function isOperationalRerankerFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['TIMEOUT', 'RATE_LIMITED', 'UPSTREAM_5XX', 'NETWORK'].includes(
    String((error as { code: unknown }).code),
  );
}

function reorderBundle(
  bundle: EvidenceBundle,
  orderedSourceIds: readonly string[],
): EvidenceBundle {
  const byId = new Map(bundle.sources.map((source) => [source.sourceId, source]));
  const ordered = orderedSourceIds.flatMap((sourceId) => {
    const source = byId.get(sourceId);
    return source ? [source] : [];
  });
  for (const source of bundle.sources) {
    if (!orderedSourceIds.includes(source.sourceId)) ordered.push(source);
  }
  return {
    ...bundle,
    sources: ordered,
    bundleSha256: createHash('sha256')
      .update(JSON.stringify({ previous: bundle.bundleSha256, orderedSourceIds }))
      .digest('hex'),
  };
}

function terminalValidation(route: EvidenceRoute, validatorProfileId: string): ValidationReport {
  return {
    outcome: route === 'CLARIFY' ? 'PASS' : 'REJECT',
    issues:
      route === 'CLARIFY'
        ? []
        : [
            {
              code: `EVIDENCE_ROUTE_${route}`,
              severity: 'BLOCKING',
              claimId: null,
              description: '证据路由不允许生成自由答案',
            },
          ],
    checkedClaimCount: 0,
    validSourceIds: [],
    validatorProfileId,
    semanticJudge: null,
  };
}

function timedNode(
  stage: string,
  dependencies: AnswerGenerationGraphDependencies,
  node: (
    state: AnswerGenerationStateValue,
  ) => Partial<AnswerGenerationStateValue> | Promise<Partial<AnswerGenerationStateValue>>,
  attemptOf: (state: AnswerGenerationStateValue) => number = () => 1,
): GraphNode<typeof AnswerGenerationState> {
  return async (state) => {
    const started = performance.now();
    const attempt = attemptOf(state);
    await dependencies.audit?.start(state.runId, stage, attempt, stateSummary(state));
    try {
      const result = await node(state);
      dependencies.telemetry.stage(stage, Math.round(performance.now() - started), 'success');
      await dependencies.audit?.finish(state.runId, stage, attempt, 'SUCCEEDED', {
        ...resultSummary(result),
        durationMs: Math.round(performance.now() - started),
      });
      return result;
    } catch (error) {
      dependencies.telemetry.stage(stage, Math.round(performance.now() - started), 'failure');
      await dependencies.audit?.finish(state.runId, stage, attempt, 'FAILED', {
        errorCode: answerDiagnosticErrorCode(error, state.signal),
        durationMs: Math.round(performance.now() - started),
      });
      throw error;
    }
  };
}

function stateSummary(state: AnswerGenerationStateValue): Readonly<Record<string, unknown>> {
  return {
    candidateCount: state.candidates.length,
    evidenceCount: state.bundle?.sources.length ?? 0,
    generationAttempt: state.generationAttempt,
    route: state.route ?? null,
  };
}

function resultSummary(
  result: Partial<AnswerGenerationStateValue>,
): Readonly<Record<string, unknown>> {
  return {
    candidateCount: result.candidates?.length,
    evidenceCount: result.bundle?.sources.length,
    route: result.route,
    validationOutcome: result.validation?.outcome,
    finalStatus: result.finalAnswer?.status,
    degraded: result.degraded,
    generationAttempt: result.generationAttempt,
    contextIncludedCount: result.answerContext?.includedSourceIds.length,
    contextOmittedCount: result.answerContext?.omittedSourceIds.length,
    contextEstimatedTokens: result.answerContext?.estimatedTokens,
    authorizedSpaceIds: result.retrieval?.allowedSpaceIds,
    // OPT-001：只计算 PG 扩展复核后的材料，不把原始向量命中的无权对象计入公开数量。
    accessibleDocumentCount: result.materials
      ? new Set(result.materials.map((material) => material.documentId)).size
      : undefined,
    expandedEvidenceCount: result.materials?.length,
    logicalModelCallCount: result.logicalModelCallCount,
    materialRemovalReasons: result.materialRemovalReasons,
    validationIssueCodes: result.validation
      ? [...new Set(result.validation.issues.map((issue) => issue.code))]
      : undefined,
  };
}

function requireRetrieval(value: HybridRetrievalResult | undefined): HybridRetrievalResult {
  if (!value) throw new Error('答案图缺少检索结果');
  return value;
}

function requireRun(value: RagRun | undefined): RagRun {
  if (!value) throw new Error('答案图缺少 Run 快照');
  return value;
}

/**
 * OPS-016：优先使用 Run 快照中的灰度决策；多空间存在专属决策时采用“全部开启才开启”的
 * 保守语义，避免同一回答只对部分证据应用 Validator/重排策略。
 */
function featureEnabled(
  state: AnswerGenerationStateValue,
  key: string,
  configuredDefault: boolean,
): boolean {
  const decisions = state.run?.snapshot.featureFlags?.filter((item) => item.key === key) ?? [];
  const scoped = decisions.filter((item) => item.scope === 'SPACE');
  if (scoped.length > 0) return scoped.every((item) => item.enabled);
  return decisions.find((item) => item.scope === 'SYSTEM')?.enabled ?? configuredDefault;
}

function requireBundle(value: EvidenceBundle | undefined): EvidenceBundle {
  if (!value) throw new Error('答案图缺少 EvidenceBundle');
  return value;
}

function requireRoute(value: EvidenceRoute | undefined): EvidenceRoute {
  if (!value) throw new Error('答案图缺少 EvidenceRoute');
  return value;
}

function requireAnswerableRoute(value: EvidenceRoute | undefined): 'ANSWER' | 'PARTIAL_ANSWER' {
  if (value !== 'ANSWER' && value !== 'PARTIAL_ANSWER') throw new Error('当前路由禁止生成答案');
  return value;
}

function requireAnswerContext(value: AnswerContext | undefined): AnswerContext {
  if (!value) throw new Error('答案图缺少安全上下文');
  return value;
}

/** 返回模型与校验器共同使用的实际可见证据窗口。 */
function visibleEvidenceBundle(
  state: Pick<AnswerGenerationStateValue, 'bundle' | 'answerContext'>,
): EvidenceBundle {
  return evidenceBundleForAnswerContext(
    requireBundle(state.bundle),
    requireAnswerContext(state.answerContext),
  );
}

function requireDraft(value: AnswerDraft | undefined): AnswerDraft {
  if (!value) throw new Error('答案图缺少结构化草稿');
  return value;
}

function requireValidation(value: ValidationReport | undefined): ValidationReport {
  if (!value) throw new Error('答案图缺少校验报告');
  return value;
}
