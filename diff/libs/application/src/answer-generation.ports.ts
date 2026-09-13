/**
 * 证据、生成与答案校验的应用层端口。
 *
 * LangGraph 和纯业务规则只依赖这些接口；Reranker/LLM HTTP、PostgreSQL、Prometheus 以及
 * DeepSeek 或内网模型协议均由 Adapter 隔离。每个远程调用继续使用统一 Deadline、单次超时
 * 和 AbortSignal，任何 Provider 原始响应都不能进入日志或用户错误。
 *
 * @requirement ANS-001
 * @requirement ANS-002
 * @requirement ANS-003
 * @requirement ANS-006
 * @requirement ANS-009
 * @requirement ANS-013
 */
import type {
  AnswerContext,
  AnswerDraft,
  DeterministicCalculation,
  EvidenceBundle,
  EvidenceRelation,
  EvidenceSource,
  RagRun,
  RerankDocument,
  RerankResponse,
  RetrievalCandidate,
  RunManifestSnapshot,
  SemanticGroundingReport,
} from '@rag/contracts';
import type { ProviderCallOptions } from './indexing.ports';
import type { AccessContext } from './ports';

/** Reranker 启动兼容性元数据。 */
export interface RerankerMetadata {
  readonly provider: string;
  readonly modelId: string;
  readonly revision: string;
  readonly protocolVersion: string;
  readonly maximumCandidates: number;
  readonly maximumInputTokens: number;
}

/** Reranker 远程调用输入。 */
export interface RerankInput {
  readonly query: string;
  readonly documents: readonly RerankDocument[];
  readonly topN: number;
}

/** 专用 Reranker 端口；不得用生成模型的自由文本评分替代。 */
export interface RerankerPort {
  checkHealth(options: ProviderCallOptions): Promise<void>;
  getMetadata(options: ProviderCallOptions): Promise<RerankerMetadata>;
  rerank(input: RerankInput, options: ProviderCallOptions): Promise<RerankResponse>;
}

/** PG 扩展返回的来源事实；sourceId、权威级别和覆盖由纯 Evidence Builder 生成。 */
export interface ExpandedEvidenceMaterial {
  readonly relation: EvidenceRelation;
  readonly originCandidateId: string;
  readonly manifestId: string;
  readonly spaceId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly chunkId: string;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly content: string;
  readonly sourceLocations: readonly unknown[];
  readonly publishedAt: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** Parent/Neighbor/Table Header 扩展与复核命令。 */
export interface ExpandEvidenceCommand {
  readonly run: RagRun;
  readonly candidates: readonly RetrievalCandidate[];
  readonly manifests: readonly RunManifestSnapshot[];
  readonly currentlyAllowedSpaceIds: readonly string[];
  readonly asOf: Date;
}

/** 扩展结果不返回被移除资源元数据，只给稳定计数。 */
export interface ExpandEvidenceResult {
  readonly materials: readonly ExpandedEvidenceMaterial[];
  readonly removedByReason: Readonly<Record<string, number>>;
}

/** 证据来源事实端口；扩展和最终引用校验都必须回到 PostgreSQL。 */
export interface EvidenceSourceRepository {
  expandAndRecheck(
    context: AccessContext,
    command: ExpandEvidenceCommand,
  ): Promise<ExpandEvidenceResult>;
  revalidateSources(
    context: AccessContext,
    sources: readonly EvidenceSource[],
    asOf: Date,
  ): Promise<readonly string[]>;
}

/** 结构化答案生成输入。 */
export interface GenerateAnswerDraftInput {
  readonly question: string;
  readonly route: 'ANSWER' | 'PARTIAL_ANSWER';
  readonly context: AnswerContext;
  readonly calculations: readonly DeterministicCalculation[];
  /** Semantic Judge 关闭时为 true；模型只能输出可由文字窗口确定性核对的 DIRECT Claim。 */
  readonly directEvidenceOnly: boolean;
  readonly previousDraft?: AnswerDraft;
  readonly repairInstructions?: readonly string[];
}

/** 低置信证据的条件式 LLM 精排输入。 */
export interface LlmEvidenceRerankInput {
  readonly question: string;
  readonly bundle: EvidenceBundle;
}

/** LLM 证据精排只能返回已有 sourceId 的次序。 */
export interface LlmEvidenceRerankResult {
  readonly orderedSourceIds: readonly string[];
  readonly reason: string;
}

/** Semantic Judge 输入仅包含规则无法确定的 Claim。 */
export interface SemanticGroundingInput {
  readonly draft: AnswerDraft;
  readonly bundle: EvidenceBundle;
  readonly claimIds: readonly string[];
  readonly reason: string;
}

/** 结构化 LLM 能力端口；查询改写之外的生成能力统一由本接口承载。 */
export interface AnswerModelPort {
  generateDraft(
    input: GenerateAnswerDraftInput,
    options: ProviderCallOptions,
  ): Promise<AnswerDraft>;
  rerankEvidence(
    input: LlmEvidenceRerankInput,
    options: ProviderCallOptions,
  ): Promise<LlmEvidenceRerankResult>;
  judgeGrounding(
    input: SemanticGroundingInput,
    options: ProviderCallOptions,
  ): Promise<SemanticGroundingReport>;
}

/** 与监控实现解耦的答案链路遥测。 */
export interface AnswerGenerationTelemetryPort {
  route(route: string): void;
  validation(outcome: string): void;
  degradation(reason: string): void;
  stage(stage: string, durationMs: number, result: 'success' | 'failure'): void;
}

/** Reranker Port 注入 Token。 */
export const RERANKER_PORT = Symbol('RERANKER_PORT');
/** 证据来源 Repository 注入 Token。 */
export const EVIDENCE_SOURCE_REPOSITORY = Symbol('EVIDENCE_SOURCE_REPOSITORY');
/** 结构化答案模型 Port 注入 Token。 */
export const ANSWER_MODEL_PORT = Symbol('ANSWER_MODEL_PORT');
/** 答案链路遥测 Port 注入 Token。 */
export const ANSWER_GENERATION_TELEMETRY = Symbol('ANSWER_GENERATION_TELEMETRY');
