/**
 * M07 LangGraph 确定性混合检索子图。
 *
 * 图按“路由→计划→可选 LLM 改写→查询 Embedding→Dense/Sparse 并行召回→RRF→PG 回源→
 * 最多一次放宽重试→多样性控制”执行。节点和条件边由代码固定，LLM 不是自由行动的 Agent；
 * 它不能生成 Filter、SQL 或 Milvus expression。M08 将把本子图作为生成图的一个节点复用。
 *
 * @requirement RET-001
 * @requirement RET-002
 * @requirement RET-004
 * @requirement RET-008
 * @requirement RET-009
 * @requirement RET-015
 */
import { END, START, StateGraph, StateSchema, type GraphNode } from '@langchain/langgraph';
import {
  ApplicationError,
  type AccessContext,
  type EmbeddingPort,
  type ProviderCallOptions,
  type QueryRewritePort,
  type RagRunCancellationPort,
  type RetrievalCachePort,
  type RetrievalSourceRepository,
  type RetrievalTelemetryPort,
  type SensitiveTextProtectorPort,
  type VectorIndexPort,
  type AuthorizationService,
} from '@rag/application';
import {
  RetrievalDebugResultSchema,
  RetrievalFilterSchema,
  RetrievalPlanSchema,
  RetrievalProfileSnapshotSchema,
  RetrievalRouteSchema,
  type FusedRetrievalCandidate,
  type QueryEmbeddingCacheValue,
  type RetrievalCandidate,
  type RetrievalDebugResult,
  type RetrievalEntity,
  type RetrievalFilter,
  type RetrievalPlan,
  type RetrievalProfileSnapshot,
  type RetrievalRoute,
  type RetrievalRouteSummary,
  type RunManifestSnapshot,
} from '@rag/contracts';
import {
  buildRetrievalPlan,
  buildSecondRoundQuestion,
  compileRetrievalFilter,
  diversifyCandidates,
  extractExactLiterals,
  routeQuery,
  shouldUseLlmRewrite,
  weightedReciprocalRankFusion,
  type WeightedRetrievalList,
} from '@rag/retrieval';
import { createHash } from 'node:crypto';
import { z } from 'zod/v4';

const RetrievalState = new StateSchema({
  runId: z.string(),
  context: z.custom<AccessContext>(),
  question: z.string(),
  historyEntities: z.custom<readonly RetrievalEntity[]>(),
  manifests: z.custom<readonly RunManifestSnapshot[]>(),
  allowedSpaceIds: z.array(z.string()),
  profile: RetrievalProfileSnapshotSchema,
  authScopeSha256: z.string(),
  asOf: z.date(),
  deadlineAt: z.date(),
  signal: z.custom<AbortSignal>(),
  route: RetrievalRouteSchema.optional(),
  literals: z.custom<ReturnType<typeof extractExactLiterals>>().default(() => []),
  filter: RetrievalFilterSchema.optional(),
  plan: RetrievalPlanSchema.optional(),
  needsRewrite: z.boolean().default(false),
  embeddings: z.custom<readonly QueryEmbeddingCacheValue[]>().default(() => []),
  fused: z.custom<readonly FusedRetrievalCandidate[]>().default(() => []),
  hydrated: z.custom<readonly RetrievalCandidate[]>().default(() => []),
  accumulated: z.custom<readonly RetrievalCandidate[]>().default(() => []),
  candidates: z.custom<readonly RetrievalCandidate[]>().default(() => []),
  routeSummaries: z.custom<readonly RetrievalRouteSummary[]>().default(() => []),
  removedByReason: z.custom<Readonly<Record<string, number>>>().default(() => ({})),
  cacheHit: z.boolean().default(false),
  degraded: z.boolean().default(false),
  retryNeeded: z.boolean().default(false),
  roundCount: z.number().int().min(0).max(2).default(0),
  terminalPlanSha256: z.string().default(''),
});

type RetrievalStateValue = typeof RetrievalState.State;

/** 调用编译后 M07 图时必须提供、且不能依赖节点默认值的初始状态。 */
export interface M07RetrievalGraphInput {
  readonly runId: string;
  readonly context: AccessContext;
  readonly question: string;
  readonly historyEntities: readonly RetrievalEntity[];
  readonly manifests: readonly RunManifestSnapshot[];
  readonly allowedSpaceIds: string[];
  readonly profile: RetrievalProfileSnapshot;
  readonly authScopeSha256: string;
  readonly asOf: Date;
  readonly deadlineAt: Date;
  readonly signal: AbortSignal;
}

/** 对外隐藏 LangGraph 复杂泛型，只暴露 M07 需要的编译图执行能力。 */
export interface M07CompiledRetrievalGraph {
  invoke(input: M07RetrievalGraphInput): Promise<RetrievalStateValue>;
}

/** Graph 外部依赖与远程调用预算。 */
export interface M07RetrievalGraphDependencies {
  readonly rewrite: QueryRewritePort;
  readonly embedding: EmbeddingPort;
  readonly vectorIndex: VectorIndexPort;
  readonly cache: RetrievalCachePort;
  readonly source: RetrievalSourceRepository;
  readonly telemetry: RetrievalTelemetryPort;
  readonly embeddingRequestTimeoutMs: number;
  readonly vectorRequestTimeoutMs: number;
  readonly llmRequestTimeoutMs: number;
  readonly embeddingMaxInputTokens: number;
  readonly queryCacheTtlSeconds: number;
  readonly expectedEmbeddingRevision: string;
  readonly expectedEmbeddingModelId: string;
  readonly expectedEmbeddingDimension: number;
}

/** M08 可直接消费的 M07 内部结果。 */
export interface M07RetrievalResult {
  readonly route: 'CHAT' | 'KNOWLEDGE' | 'CLARIFY' | 'REJECT';
  readonly plan?: RetrievalPlan;
  readonly candidates: readonly RetrievalCandidate[];
  readonly roundCount: number;
  readonly cacheHit: boolean;
  readonly degraded: boolean;
  readonly routeSummaries: readonly RetrievalRouteSummary[];
  readonly removedByReason: Readonly<Record<string, number>>;
  readonly exactLiteralKinds: readonly ReturnType<typeof extractExactLiterals>[number]['kind'][];
  readonly terminalPlanSha256: string;
}

/** 构造并编译 M07 LangGraph；编译会检查孤立节点与边定义。 */
export function createM07RetrievalGraph(
  dependencies: M07RetrievalGraphDependencies,
): M07CompiledRetrievalGraph {
  const routeNode: GraphNode<typeof RetrievalState> = timedNode(
    'route',
    dependencies.telemetry,
    (state) => {
      const route = routeQuery(state.question, state.historyEntities);
      dependencies.telemetry.route(route);
      const literals = extractExactLiterals(state.question);
      return {
        route,
        literals,
        terminalPlanSha256: createHash('sha256')
          .update(`route:${route}:${state.question}`)
          .digest('hex'),
      };
    },
  );

  const planNode: GraphNode<typeof RetrievalState> = timedNode(
    'plan',
    dependencies.telemetry,
    (state) => {
      const route = requireRoute(state.route);
      const filter = compileRetrievalFilter({
        manifests: state.manifests,
        currentlyAllowedSpaceIds: state.allowedSpaceIds,
        asOf: state.asOf,
      });
      const profile = requireUniformProfile(state.manifests, state);
      const plan = buildRetrievalPlan({
        question: state.question,
        route,
        literals: state.literals,
        historyEntities: state.historyEntities,
        filter,
        profile,
        round: 1,
      });
      return {
        filter,
        plan,
        needsRewrite: shouldUseLlmRewrite(state.question, route, state.historyEntities),
        terminalPlanSha256: plan.planSha256,
      };
    },
  );

  const rewriteNode: GraphNode<typeof RetrievalState> = timedNode(
    'rewrite',
    dependencies.telemetry,
    async (state) => {
      const plan = requirePlan(state.plan);
      try {
        const suggestion = await dependencies.rewrite.rewrite(
          {
            question: state.question,
            exactLiterals: state.literals,
            historyEntities: state.historyEntities,
            maximumSubQuestions: 4,
          },
          providerOptions(state, dependencies.llmRequestTimeoutMs),
        );
        const rewritten = buildRetrievalPlan({
          question: state.question,
          route: plan.route,
          literals: state.literals,
          historyEntities: state.historyEntities,
          filter: requireFilter(state.filter),
          profile: plan.profile,
          round: 1,
          suggestion,
        });
        return { plan: rewritten, terminalPlanSha256: rewritten.planSha256 };
      } catch {
        if (state.signal.aborted) throw state.signal.reason;
        // 改写是可选增强：失败时保留已通过确定性规则构造的原问题计划，不扩大权限或过滤范围。
        return {
          degraded: true,
          removedByReason: mergeCounts(state.removedByReason, { REWRITE_DEGRADED: 1 }),
        };
      }
    },
  );

  const embeddingNode: GraphNode<typeof RetrievalState> = timedNode(
    'query_embedding',
    dependencies.telemetry,
    async (state) => embedPlanQueries(state, dependencies),
  );

  const hybridNode: GraphNode<typeof RetrievalState> = timedNode(
    'hybrid_retrieve',
    dependencies.telemetry,
    async (state) => hybridRetrieve(state, dependencies),
  );

  const sourceNode: GraphNode<typeof RetrievalState> = timedNode(
    'source_recheck',
    dependencies.telemetry,
    async (state) => {
      const plan = requirePlan(state.plan);
      const hydrated = await dependencies.source.hydrateAndRecheck(state.context, {
        candidates: state.fused,
        manifests: state.manifests,
        filter: plan.filter,
        currentlyAllowedSpaceIds: state.allowedSpaceIds,
      });
      for (const [reason, count] of Object.entries(hydrated.removedByReason)) {
        dependencies.telemetry.removed(reason, count);
      }
      return {
        hydrated: hydrated.candidates,
        accumulated: mergeCandidates(state.accumulated, hydrated.candidates),
        removedByReason: mergeCounts(state.removedByReason, hydrated.removedByReason),
        roundCount: plan.round,
      };
    },
  );

  const assessNode: GraphNode<typeof RetrievalState> = timedNode(
    'assess_retrieval',
    dependencies.telemetry,
    (state) => {
      const plan = requirePlan(state.plan);
      return {
        retryNeeded:
          plan.round < plan.profile.maxRounds &&
          state.accumulated.length < plan.profile.minimumResults,
      };
    },
  );

  const retryNode: GraphNode<typeof RetrievalState> = timedNode(
    'retry_plan',
    dependencies.telemetry,
    (state) => {
      const previous = requirePlan(state.plan);
      const retried = buildRetrievalPlan({
        question: buildSecondRoundQuestion(previous),
        route: previous.route,
        literals: state.literals,
        historyEntities: state.historyEntities,
        filter: previous.filter,
        profile: previous.profile,
        round: 2,
      });
      return {
        plan: retried,
        retryNeeded: false,
        terminalPlanSha256: retried.planSha256,
      };
    },
  );

  const finalizeNode: GraphNode<typeof RetrievalState> = timedNode(
    'diversify',
    dependencies.telemetry,
    (state) => {
      const plan = state.plan;
      if (!plan) return { candidates: [] };
      return {
        candidates: diversifyCandidates(state.accumulated, {
          limit: plan.profile.finalTopK,
          maxPerDocument: plan.profile.maxPerDocument,
          maxPerSection: plan.profile.maxPerSection,
        }),
      };
    },
  );

  return new StateGraph(RetrievalState)
    .addNode('route_query', routeNode)
    .addNode('build_plan', planNode)
    .addNode('rewrite_query', rewriteNode)
    .addNode('query_embedding', embeddingNode)
    .addNode('hybrid_retrieve', hybridNode)
    .addNode('source_recheck', sourceNode)
    .addNode('assess_retrieval', assessNode)
    .addNode('retry_plan', retryNode)
    .addNode('diversify', finalizeNode)
    .addEdge(START, 'route_query')
    .addConditionalEdges('route_query', (state) =>
      state.route === 'KNOWLEDGE' ? 'build_plan' : 'diversify',
    )
    .addConditionalEdges('build_plan', (state) =>
      state.needsRewrite ? 'rewrite_query' : 'query_embedding',
    )
    .addEdge('rewrite_query', 'query_embedding')
    .addEdge('query_embedding', 'hybrid_retrieve')
    .addEdge('hybrid_retrieve', 'source_recheck')
    .addEdge('source_recheck', 'assess_retrieval')
    .addConditionalEdges('assess_retrieval', (state) =>
      state.retryNeeded ? 'retry_plan' : 'diversify',
    )
    .addEdge('retry_plan', 'query_embedding')
    .addEdge('diversify', END)
    .compile() as unknown as M07CompiledRetrievalGraph;
}

/**
 * M07 应用入口：普通 retrieve 供 M08 复用；debug 额外要求管理员/审计角色并移除正文。
 */
export class M07RetrievalService {
  private readonly graph: ReturnType<typeof createM07RetrievalGraph>;

  public constructor(
    dependencies: M07RetrievalGraphDependencies,
    private readonly source: RetrievalSourceRepository,
    private readonly authorization: AuthorizationService,
    private readonly protector: SensitiveTextProtectorPort,
    private readonly cancellation: RagRunCancellationPort,
  ) {
    this.graph = createM07RetrievalGraph(dependencies);
  }

  /** 执行真实检索子图；只允许 Run owner，且执行前按当前身份重新收窄空间。 */
  public async retrieve(context: AccessContext, runId: string): Promise<M07RetrievalResult> {
    const input = await this.source.loadRunInput(context, runId);
    const question = this.protector.reveal(input.protectedQuestion);
    if (!question) throw new ApplicationError('CONTENT_REDACTED', 410, '问题正文已按保留策略清理');
    const deadlineAt = new Date(input.run.deadlineAt);
    if (deadlineAt.getTime() <= Date.now()) {
      throw new ApplicationError('DEADLINE_EXCEEDED', 408, 'Run 已超过执行期限');
    }
    const requestedSpaces = input.run.snapshot.manifests.map((manifest) => manifest.spaceId);
    const allowedSpaceIds = await this.authorization.restrictRequestedSpaces(
      context,
      requestedSpaces,
    );
    if (allowedSpaceIds.length === 0) {
      throw new ApplicationError('ACCESS_DENIED', 403, '当前身份没有可检索的知识空间');
    }
    const state = await this.graph.invoke({
      runId,
      context,
      question,
      historyEntities: input.historyEntities,
      manifests: input.run.snapshot.manifests,
      profile: input.run.snapshot.retrieval,
      allowedSpaceIds: [...allowedSpaceIds],
      authScopeSha256: authorizationScopeHash(context, allowedSpaceIds),
      asOf: new Date(input.run.createdAt),
      deadlineAt,
      signal: this.cancellation.signal(runId),
    });
    const route = requireRoute(state.route);
    return {
      route,
      ...(state.plan ? { plan: state.plan } : {}),
      candidates: state.candidates,
      roundCount: state.roundCount,
      cacheHit: state.cacheHit,
      degraded: state.degraded,
      routeSummaries: state.routeSummaries,
      removedByReason: state.removedByReason,
      exactLiteralKinds: state.literals.map((literal) => literal.kind),
      terminalPlanSha256: state.terminalPlanSha256,
    };
  }

  /** 仅 Run owner 中的 SYSTEM_ADMIN/AUDITOR 可查看脱敏的阶段排名与移除统计。 */
  public async debug(context: AccessContext, runId: string): Promise<RetrievalDebugResult> {
    if (!context.user.roles.some((role) => role === 'SYSTEM_ADMIN' || role === 'AUDITOR')) {
      throw new ApplicationError('ACCESS_DENIED', 403, '仅管理员或审计员可以执行检索调试');
    }
    const result = await this.retrieve(context, runId);
    return RetrievalDebugResultSchema.parse({
      runId,
      route: result.route,
      planSha256: result.plan?.planSha256 ?? result.terminalPlanSha256,
      planSource: result.plan?.source ?? 'DETERMINISTIC',
      roundCount: result.roundCount,
      subQuestionCount: result.plan?.subQuestions.length ?? 0,
      exactLiteralKinds: result.exactLiteralKinds,
      cacheHit: result.cacheHit,
      degraded: result.degraded,
      routes: result.routeSummaries,
      removedByReason: result.removedByReason,
      candidates: result.candidates.map((candidate, index) => ({
        rank: index + 1,
        vectorId: candidate.vectorId,
        spaceId: candidate.spaceId,
        documentId: candidate.documentId,
        documentVersionId: candidate.documentVersionId,
        chunkId: candidate.chunkId,
        title: candidate.title,
        headingPath: candidate.headingPath,
        denseRank: candidate.denseRank,
        sparseRank: candidate.sparseRank,
        rrfScore: candidate.rrfScore,
      })),
    });
  }
}

async function embedPlanQueries(
  state: RetrievalStateValue,
  dependencies: M07RetrievalGraphDependencies,
): Promise<Partial<RetrievalStateValue>> {
  const plan = requirePlan(state.plan);
  const cacheKeys = plan.subQuestions.map((query) =>
    createHash('sha256')
      .update(
        `${state.manifests[0]?.embeddingProfileId ?? 'missing'}:${plan.profile.profileId}:${dependencies.expectedEmbeddingRevision}:${plan.planSha256}:${state.authScopeSha256}:${createHash('sha256').update(query).digest('hex')}`,
      )
      .digest('hex'),
  );
  const cached = (
    await Promise.all(cacheKeys.map((key) => dependencies.cache.getQueryEmbedding(key)))
  ).map((value) =>
    value &&
    value.modelId === dependencies.expectedEmbeddingModelId &&
    value.revision === dependencies.expectedEmbeddingRevision &&
    value.dense.length === dependencies.expectedEmbeddingDimension
      ? value
      : undefined,
  );
  const missingIndexes = cached.flatMap((value, index) => (value ? [] : [index]));
  dependencies.telemetry.cache(missingIndexes.length === 0 ? 'hit' : 'miss');
  const resolved = [...cached];
  if (missingIndexes.length > 0) {
    const inputs = missingIndexes.map((index) => {
      const query = plan.subQuestions[index] ?? '';
      const contentSha256 = createHash('sha256').update(query).digest('hex');
      return {
        itemId: `query-${index}`,
        contentSha256,
        text: query,
        tokenCount: estimatedQueryTokens(query, dependencies.embeddingMaxInputTokens),
      };
    });
    const response = await dependencies.embedding.embedQueries(
      inputs,
      providerOptions(state, dependencies.embeddingRequestTimeoutMs),
    );
    const outputs = new Map(response.outputs.map((output) => [output.itemId, output]));
    if (response.failures.length > 0 || outputs.size !== inputs.length) {
      throw new ApplicationError('EMBEDDING_FAILED', 502, '查询向量化未返回完整结果');
    }
    for (const index of missingIndexes) {
      const output = outputs.get(`query-${index}`);
      if (
        !output ||
        output.modelId !== dependencies.expectedEmbeddingModelId ||
        output.revision !== dependencies.expectedEmbeddingRevision ||
        output.dense.length !== dependencies.expectedEmbeddingDimension
      ) {
        throw new ApplicationError(
          'PROVIDER_PROFILE_MISMATCH',
          409,
          '查询 Embedding 修订与 Run 快照不一致',
        );
      }
      const value: QueryEmbeddingCacheValue = {
        dense: output.dense,
        sparse: output.sparse,
        modelId: output.modelId,
        revision: output.revision,
      };
      resolved[index] = value;
      await dependencies.cache
        .setQueryEmbedding(cacheKeys[index] ?? '', value, dependencies.queryCacheTtlSeconds)
        .catch(() => dependencies.telemetry.cache('write_failed'));
    }
  }
  if (resolved.some((value) => value === undefined)) {
    throw new ApplicationError('EMBEDDING_FAILED', 502, '查询向量缓存合并失败');
  }
  return {
    embeddings: resolved.filter((value): value is QueryEmbeddingCacheValue => Boolean(value)),
    cacheHit: missingIndexes.length === 0,
  };
}

async function hybridRetrieve(
  state: RetrievalStateValue,
  dependencies: M07RetrievalGraphDependencies,
): Promise<Partial<RetrievalStateValue>> {
  const plan = requirePlan(state.plan);
  const visibleManifests = state.manifests.filter((manifest) =>
    state.allowedSpaceIds.includes(manifest.spaceId),
  );
  const densePromise = Promise.all(
    combinations(state.embeddings, visibleManifests).map(
      async ({ embedding, manifest, queryIndex }) => ({
        manifest,
        queryIndex,
        hits: await dependencies.vectorIndex.searchManifestDense(
          manifest.collectionName,
          manifest.manifestId,
          embedding.dense,
          plan.profile.initialTopK,
          providerOptions(state, dependencies.vectorRequestTimeoutMs),
        ),
      }),
    ),
  );
  const sparseAvailable = state.embeddings.some((embedding) => embedding.sparse !== null);
  const sparsePromise = sparseAvailable
    ? Promise.all(
        combinations(state.embeddings, visibleManifests)
          .filter(({ embedding }) => embedding.sparse !== null)
          .map(async ({ embedding, manifest, queryIndex }) => ({
            manifest,
            queryIndex,
            hits: await dependencies.vectorIndex.searchManifestSparse(
              manifest.collectionName,
              manifest.manifestId,
              requireSparse(embedding),
              plan.profile.initialTopK,
              providerOptions(state, dependencies.vectorRequestTimeoutMs),
            ),
          })),
      )
    : undefined;
  const [denseResult, sparseResult] = await Promise.allSettled([
    densePromise,
    sparsePromise ?? Promise.resolve(undefined),
  ]);
  if (state.signal.aborted) throw state.signal.reason;
  const summaries: RetrievalRouteSummary[] = [];
  const lists: WeightedRetrievalList[] = [];
  if (denseResult.status === 'fulfilled') {
    const hitCount = denseResult.value.reduce((sum, item) => sum + item.hits.length, 0);
    summaries.push({ route: 'DENSE', status: 'SUCCEEDED', hitCount, errorCode: null });
    dependencies.telemetry.retrievalRoute('DENSE', 'success');
    for (const item of denseResult.value) {
      lists.push({
        route: 'DENSE',
        weight: plan.profile.denseWeight / Math.max(1, plan.subQuestions.length),
        hits: item.hits.map((hit, index) => ({
          ...hit,
          manifestId: item.manifest.manifestId,
          spaceId: item.manifest.spaceId,
          route: 'DENSE' as const,
          rank: index + 1,
        })),
      });
    }
  } else {
    summaries.push({ route: 'DENSE', status: 'DEGRADED', hitCount: 0, errorCode: 'DENSE_FAILED' });
    dependencies.telemetry.retrievalRoute('DENSE', 'degraded');
  }
  if (!sparseAvailable) {
    summaries.push({
      route: 'SPARSE',
      status: 'UNAVAILABLE',
      hitCount: 0,
      errorCode: 'SPARSE_NOT_CONFIGURED',
    });
    dependencies.telemetry.retrievalRoute('SPARSE', 'degraded');
  } else if (sparseResult.status === 'fulfilled' && sparseResult.value) {
    const hitCount = sparseResult.value.reduce((sum, item) => sum + item.hits.length, 0);
    summaries.push({ route: 'SPARSE', status: 'SUCCEEDED', hitCount, errorCode: null });
    dependencies.telemetry.retrievalRoute('SPARSE', 'success');
    for (const item of sparseResult.value) {
      lists.push({
        route: 'SPARSE',
        weight: plan.profile.sparseWeight / Math.max(1, plan.subQuestions.length),
        hits: item.hits.map((hit, index) => ({
          ...hit,
          manifestId: item.manifest.manifestId,
          spaceId: item.manifest.spaceId,
          route: 'SPARSE' as const,
          rank: index + 1,
        })),
      });
    }
  } else {
    summaries.push({
      route: 'SPARSE',
      status: 'DEGRADED',
      hitCount: 0,
      errorCode: 'SPARSE_FAILED',
    });
    dependencies.telemetry.retrievalRoute('SPARSE', 'degraded');
  }
  if (lists.length === 0) {
    throw new ApplicationError('RETRIEVAL_UNAVAILABLE', 503, 'Dense 与 Sparse 检索路线均不可用');
  }
  return {
    fused: weightedReciprocalRankFusion(lists, plan.profile.rrfK, plan.profile.initialTopK),
    routeSummaries: [...state.routeSummaries, ...summaries],
    degraded: state.degraded || summaries.some((summary) => summary.status !== 'SUCCEEDED'),
  };
}

function combinations(
  embeddings: readonly QueryEmbeddingCacheValue[],
  manifests: readonly RunManifestSnapshot[],
): readonly {
  readonly embedding: QueryEmbeddingCacheValue;
  readonly manifest: RunManifestSnapshot;
  readonly queryIndex: number;
}[] {
  return embeddings.flatMap((embedding, queryIndex) =>
    manifests.map((manifest) => ({ embedding, manifest, queryIndex })),
  );
}

function requireSparse(
  embedding: QueryEmbeddingCacheValue,
): NonNullable<QueryEmbeddingCacheValue['sparse']> {
  if (!embedding.sparse) throw new Error('Sparse 向量缺失');
  return embedding.sparse;
}

function providerOptions(
  state: Pick<RetrievalStateValue, 'signal' | 'deadlineAt'>,
  timeoutMs: number,
): ProviderCallOptions {
  return { signal: state.signal, timeoutMs, deadlineAt: state.deadlineAt };
}

function estimatedQueryTokens(query: string, maximum: number): number {
  const estimated = Math.max(1, Math.ceil(query.length / 3));
  if (estimated > maximum) {
    throw new ApplicationError('INVALID_STATE', 409, '查询超过 Embedding Profile 输入上限');
  }
  return estimated;
}

function requirePlan(plan: RetrievalPlan | undefined): RetrievalPlan {
  if (!plan) throw new Error('LangGraph 查询计划缺失');
  return plan;
}

function requireFilter(filter: RetrievalFilter | undefined): RetrievalFilter {
  if (!filter) throw new Error('LangGraph Filter 缺失');
  return filter;
}

function requireRoute(route: RetrievalStateValue['route']): RetrievalRoute {
  return RetrievalRouteSchema.parse(route);
}

function requireUniformProfile(
  manifests: readonly RunManifestSnapshot[],
  state: RetrievalStateValue,
): RetrievalProfileSnapshot {
  const first = manifests[0];
  if (
    !first ||
    manifests.some((manifest) => manifest.embeddingProfileId !== first.embeddingProfileId)
  ) {
    throw new ApplicationError(
      'PROVIDER_PROFILE_MISMATCH',
      409,
      '一次 Run 的 Manifest 必须使用同一查询 Embedding Profile',
    );
  }
  // profile 参数从 M06 Run 快照透传，不能在图执行中读取热更新环境变量。
  return state.profile;
}

function mergeCandidates(
  previous: readonly RetrievalCandidate[],
  current: readonly RetrievalCandidate[],
): readonly RetrievalCandidate[] {
  const merged = new Map(previous.map((candidate) => [candidate.vectorId, candidate]));
  for (const candidate of current) {
    const existing = merged.get(candidate.vectorId);
    if (!existing || candidate.rrfScore > existing.rrfScore)
      merged.set(candidate.vectorId, candidate);
  }
  return [...merged.values()].sort(
    (left, right) => right.rrfScore - left.rrfScore || left.vectorId.localeCompare(right.vectorId),
  );
}

function mergeCounts(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const merged: Record<string, number> = { ...left };
  for (const [key, value] of Object.entries(right)) merged[key] = (merged[key] ?? 0) + value;
  return merged;
}

function authorizationScopeHash(
  context: AccessContext,
  allowedSpaceIds: readonly string[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        userId: context.user.userId,
        roles: [...context.user.roles].sort(),
        authzVersion: context.user.authzVersion,
        spaces: [...allowedSpaceIds].sort(),
      }),
    )
    .digest('hex');
}

function timedNode(
  stage: string,
  telemetry: RetrievalTelemetryPort,
  node: (
    state: RetrievalStateValue,
  ) => Partial<RetrievalStateValue> | Promise<Partial<RetrievalStateValue>>,
): GraphNode<typeof RetrievalState> {
  return async (state) => {
    const started = performance.now();
    try {
      const result = await node(state);
      telemetry.stage(stage, Math.round(performance.now() - started), 'success');
      return result;
    } catch (error) {
      telemetry.stage(stage, Math.round(performance.now() - started), 'failure');
      throw error;
    }
  };
}
