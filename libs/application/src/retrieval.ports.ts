/**
 * 查询规划与混合检索 查询改写、Embedding 缓存、PostgreSQL 回源与可观测性端口。
 *
 * LangGraph 只依赖这些抽象；OpenAI-compatible HTTP、Redis、PostgreSQL、Prometheus 与具体 SDK
 * 均由 Adapter 实现。端口只接受结构化 Filter 和 Run 快照，不提供原始 SQL/Milvus 表达式参数。
 *
 * @requirement RET-004
 * @requirement RET-007
 * @requirement RET-008
 * @requirement RET-012
 * @requirement RET-013
 * @requirement RET-016
 */
import type {
  ExactLiteral,
  FusedRetrievalCandidate,
  QueryEmbeddingCacheValue,
  QueryRewriteSuggestion,
  RagRun,
  RetrievalCandidate,
  RetrievalEntity,
  RetrievalFilter,
  RunManifestSnapshot,
} from '@rag/contracts';
import type { AccessContext } from './ports';
import type { ProtectedSensitiveText } from './rag-run.ports';
import type { ProviderCallOptions } from './indexing.ports';

/** 模型改写输入；原文只存在于受 Deadline/取消约束的调用内存中。 */
export interface QueryRewriteInput {
  readonly question: string;
  readonly exactLiterals: readonly ExactLiteral[];
  readonly historyEntities: readonly RetrievalEntity[];
  readonly maximumSubQuestions: 4;
}

/** 查询改写模型端口。 */
export interface QueryRewritePort {
  rewrite(input: QueryRewriteInput, options: ProviderCallOptions): Promise<QueryRewriteSuggestion>;
}

/** Redis 查询向量缓存；故障必须表现为 miss，不得阻断权限复核。 */
export interface RetrievalCachePort {
  getQueryEmbedding(key: string): Promise<QueryEmbeddingCacheValue | undefined>;
  setQueryEmbedding(
    key: string,
    value: QueryEmbeddingCacheValue,
    ttlSeconds: number,
  ): Promise<void>;
}

/** 从 PG 加载的 Run 私密执行输入；Controller 不得直接取得 question。 */
export interface RetrievalRunInput {
  readonly run: RagRun;
  readonly protectedQuestion: ProtectedSensitiveText;
  readonly historyEntities: readonly RetrievalEntity[];
}

/** PG 回源批量复核命令。 */
export interface HydrateRetrievalCandidatesCommand {
  readonly candidates: readonly FusedRetrievalCandidate[];
  readonly manifests: readonly RunManifestSnapshot[];
  readonly filter: RetrievalFilter;
  readonly currentlyAllowedSpaceIds: readonly string[];
}

/** PG 回源结果；失败原因只统计，不返回无权资源元数据。 */
export interface HydrateRetrievalCandidatesResult {
  readonly candidates: readonly RetrievalCandidate[];
  readonly removedByReason: Readonly<Record<string, number>>;
}

/** 查询规划与混合检索 PostgreSQL 来源事实端口。 */
export interface RetrievalSourceRepository {
  loadRunInput(context: AccessContext, runId: string): Promise<RetrievalRunInput>;
  hydrateAndRecheck(
    context: AccessContext,
    command: HydrateRetrievalCandidatesCommand,
  ): Promise<HydrateRetrievalCandidatesResult>;
}

/** 与具体指标库解耦的 查询规划与混合检索 遥测端口。 */
export interface RetrievalTelemetryPort {
  route(route: 'CHAT' | 'KNOWLEDGE' | 'CLARIFY' | 'REJECT'): void;
  cache(result: 'hit' | 'miss' | 'write_failed'): void;
  retrievalRoute(route: 'DENSE' | 'SPARSE', result: 'success' | 'degraded'): void;
  removed(reason: string, count: number): void;
  stage(stage: string, durationMs: number, result: 'success' | 'failure'): void;
}

/** 查询改写 Port 注入 Token。 */
export const QUERY_REWRITE_PORT = Symbol('QUERY_REWRITE_PORT');
/** 查询 Embedding 缓存 Port 注入 Token。 */
export const RETRIEVAL_CACHE_PORT = Symbol('RETRIEVAL_CACHE_PORT');
/** PostgreSQL 检索来源 Port 注入 Token。 */
export const RETRIEVAL_SOURCE_REPOSITORY = Symbol('RETRIEVAL_SOURCE_REPOSITORY');
/** 查询规划与混合检索 遥测 Port 注入 Token。 */
export const RETRIEVAL_TELEMETRY = Symbol('RETRIEVAL_TELEMETRY');
