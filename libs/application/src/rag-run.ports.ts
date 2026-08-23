/**
 * 会话运行与事件 会话、Run、敏感正文保护、Redis Stream 与取消传播端口。
 *
 * Application 只依赖这些接口；SQL、Redis 命令、AES-GCM 和 NestJS 生命周期由 Adapter 实现。
 * 所有读取方法都显式携带 AccessContext 或可信 ownerUserId，禁止隐式全局用户。
 *
 * @requirement RUN-001
 * @requirement RUN-002
 * @requirement RUN-004
 * @requirement RUN-007
 * @requirement RUN-008
 * @requirement RUN-010
 * @requirement RUN-014
 */
import type {
  Conversation,
  ConversationMessage,
  ConversationState,
  CitationPreview,
  CreateMessageFeedbackRequest,
  EvidenceRoute,
  EvidenceSource,
  FinalAnswerStatus,
  ListConversationsQuery,
  MessageFeedback,
  RagRun,
  RagRunEvent,
  RagRunSnapshot,
  RagRunStep,
  RagRunStepStatus,
  RunManifestSnapshot,
  SensitiveContentStorage,
  SemanticRole,
  ValidationReport,
} from '@rag/contracts';
import type { AccessContext } from './ports';

/** 密文或脱敏正文的内部持久化形状；不会直接返回 HTTP。 */
export interface ProtectedSensitiveText {
  readonly storage: SensitiveContentStorage;
  readonly value: string;
  readonly iv?: string;
  readonly authTag?: string;
  readonly sha256: string;
}

/** 合规正文保护端口；实现可切换 AES-GCM、脱敏或仅限开发的明文。 */
export interface SensitiveTextProtectorPort {
  protect(plaintext: string): ProtectedSensitiveText;
  reveal(protectedText: ProtectedSensitiveText): string | null;
  redacted(originalSha256: string): ProtectedSensitiveText;
}

/** 数据库中的消息加密事实，Application 解密后才能转换为公共 Message。 */
export interface StoredConversationMessage extends Omit<
  ConversationMessage,
  'content' | 'contentStoredAs'
> {
  readonly protectedContent: ProtectedSensitiveText;
}

/** 数据库中的会话摘要保护事实。 */
export interface StoredConversationState extends Omit<ConversationState, 'summary'> {
  readonly protectedSummary?: ProtectedSensitiveText;
  /** 仅供服务端重新鉴权，不暴露到公共 ConversationState。 */
  readonly summarySourceSpaceIds: readonly string[];
}

/** Graph 汇总会话状态的乐观锁命令；来源空间用于撤权后的安全降级。 */
export interface UpdateConversationStateCommand {
  readonly expectedVersion: number;
  readonly summary: ProtectedSensitiveText | null;
  readonly retentionExpiresAt: Date;
  readonly summarySourceSpaceIds: readonly string[];
  readonly confirmedEntities: readonly string[];
  readonly recentCitationIds: readonly string[];
}

/** 会话列表游标结果。 */
export interface ConversationPage {
  readonly items: readonly Conversation[];
  readonly nextCursor: string | null;
}

/** 当前空间稳定/灰度发布信息；Application 用 userId 做稳定分桶后冻结选择。 */
export interface RunPublicationRoute {
  readonly stable: RunManifestSnapshot;
  readonly candidate?: RunManifestSnapshot;
  readonly canaryPercent?: number;
  readonly canarySalt?: string;
}

/** 创建会话命令，ownerUserId 必须来自可信 UserContext。 */
export interface CreateConversationCommand {
  readonly ownerUserId: string;
  readonly title: string;
}

/** 创建 Run 的完整事务命令。 */
export interface CreateRagRunCommand {
  readonly conversationId: string;
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly question: ProtectedSensitiveText;
  readonly snapshot: RagRunSnapshot;
  readonly deadlineAt: Date;
  readonly eventExpiresAt: Date;
  readonly retentionExpiresAt: Date;
  readonly traceId?: string;
}

/** 幂等创建结果；replayed=true 表示没有创建第二条消息或 Run。 */
export interface CreateRagRunResult {
  readonly run: RagRun;
  readonly replayed: boolean;
}

/** Graph 节点开始命令，只允许保存脱敏摘要、计数和标识。 */
export interface StartRagRunStepCommand {
  readonly nodeKey: string;
  readonly attempt: number;
  readonly inputSummary: Readonly<Record<string, unknown>>;
  readonly traceId?: string;
}

/** Graph 节点完成命令。 */
export interface FinishRagRunStepCommand {
  readonly nodeKey: string;
  readonly attempt: number;
  readonly status: Extract<RagRunStepStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'SKIPPED'>;
  readonly outputSummary: Readonly<Record<string, unknown>>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/** 最终答案事务命令；正文已按同一合规策略保护。 */
export interface CompleteRagRunCommand {
  readonly expectedVersion: number;
  readonly answer: ProtectedSensitiveText;
  readonly retentionExpiresAt: Date;
  readonly citationsSummary?: Readonly<Record<string, unknown>>;
  /** 只有 Validator 最终认可的来源才能进入该集合。 */
  readonly citations?: readonly EvidenceSource[];
  /** 与答案同事务保存的路由、模型和校验审计事实。 */
  readonly answerFacts?: AnswerCompletionFacts;
}

/** 答案完成时不可变的审计事实，不包含问题或完整答案正文。 */
export interface AnswerCompletionFacts {
  readonly bundleSha256: string;
  readonly evidenceRoute: EvidenceRoute;
  readonly finalStatus: FinalAnswerStatus;
  readonly validation: ValidationReport;
  readonly reranker?: { readonly modelId: string; readonly revision: string };
  readonly llm?: { readonly modelId: string; readonly revision: string };
}

/** 数据库租约领取的待执行 Run；角色来自创建 Run 时的可信服务端上下文。 */
export interface ClaimedRagRunExecution {
  readonly run: RagRun;
  readonly ownerUserId: string;
  readonly roles: readonly SemanticRole[];
  readonly authzVersion: number;
}

/** 待投递到 Redis Stream 的 PG Outbox 事件。 */
export interface RagRunOutboxEvent extends RagRunEvent {
  readonly attempts: number;
}

/** Redis Stream 读取结果；exists=false 表示保留期已过，应降级到 PG Run 快照。 */
export interface RagRunStreamPage {
  readonly items: readonly RagRunEvent[];
  readonly nextSequence: number;
  readonly exists: boolean;
}

/** 一次性 Stream Ticket 内部绑定。 */
export interface RunStreamTicketBinding {
  readonly runId: string;
  readonly userId: string;
}

/** PostgreSQL 会话与 Run 事实源端口。 */
export interface RagRunRepository {
  createConversation(
    context: AccessContext,
    command: CreateConversationCommand,
  ): Promise<Conversation>;
  listConversations(
    context: AccessContext,
    query: ListConversationsQuery,
  ): Promise<ConversationPage>;
  getConversation(context: AccessContext, conversationId: string): Promise<Conversation>;
  listMessages(
    context: AccessContext,
    conversationId: string,
    limit: number,
  ): Promise<{
    readonly items: readonly StoredConversationMessage[];
    readonly state: StoredConversationState;
  }>;
  updateConversationState(
    ownerUserId: string,
    conversationId: string,
    command: UpdateConversationStateCommand,
  ): Promise<StoredConversationState>;
  resolvePublicationRoutes(spaceIds: readonly string[]): Promise<readonly RunPublicationRoute[]>;
  createRun(context: AccessContext, command: CreateRagRunCommand): Promise<CreateRagRunResult>;
  getRun(context: AccessContext, runId: string): Promise<RagRun>;
  getRunByOwner(ownerUserId: string, runId: string): Promise<RagRun>;
  listRunSteps(context: AccessContext, runId: string): Promise<readonly RagRunStep[]>;
  requestCancellation(context: AccessContext, runId: string, reason: string): Promise<RagRun>;
  startRun(ownerUserId: string, runId: string, expectedVersion: number): Promise<RagRun>;
  startStep(runId: string, command: StartRagRunStepCommand): Promise<RagRunStep>;
  finishStep(runId: string, command: FinishRagRunStepCommand): Promise<RagRunStep>;
  completeRun(ownerUserId: string, runId: string, command: CompleteRagRunCommand): Promise<RagRun>;
  claimAcceptedRuns(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly ClaimedRagRunExecution[]>;
  getCitationPreview(context: AccessContext, citationId: string): Promise<CitationPreview>;
  failRun(
    ownerUserId: string,
    runId: string,
    expectedVersion: number,
    code: string,
  ): Promise<RagRun>;
  finalizeCancellation(
    ownerUserId: string,
    runId: string,
    expectedVersion: number,
  ): Promise<RagRun>;
  saveFeedback(
    context: AccessContext,
    messageId: string,
    feedback: CreateMessageFeedbackRequest,
  ): Promise<MessageFeedback>;
  claimEventOutbox(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly RagRunOutboxEvent[]>;
  markEventPublished(eventId: string, workerId: string): Promise<void>;
  releaseEvent(
    eventId: string,
    workerId: string,
    errorCode: string,
    retryDelaySeconds: number,
  ): Promise<void>;
  expireOverdueRuns(limit: number): Promise<number>;
  cleanupExpiredContent(limit: number): Promise<number>;
}

/** Redis Stream 和一次性 Ticket 端口。 */
export interface RagRunEventStreamPort {
  append(event: RagRunEvent, retentionSeconds: number, maxLength: number): Promise<void>;
  read(runId: string, afterSequence: number, limit: number): Promise<RagRunStreamPage>;
  issueTicket(binding: RunStreamTicketBinding, ttlSeconds: number): Promise<string>;
  redeemTicket(ticket: string): Promise<RunStreamTicketBinding | undefined>;
}

/** 进程内 AbortSignal 注册与广播端口；跨实例取消由 Redis Adapter 再广播到每个进程。 */
export interface RagRunCancellationPort {
  signal(runId: string): AbortSignal;
  cancel(runId: string, reason: string): void;
  release(runId: string): void;
}

/** 会话运行与事件 Repository 依赖注入 Token。 */
export const RAG_RUN_REPOSITORY = Symbol('RAG_RUN_REPOSITORY');
/** 会话运行与事件 Redis Stream 依赖注入 Token。 */
export const RAG_RUN_EVENT_STREAM = Symbol('RAG_RUN_EVENT_STREAM');
/** 会话运行与事件 敏感正文保护器依赖注入 Token。 */
export const SENSITIVE_TEXT_PROTECTOR = Symbol('SENSITIVE_TEXT_PROTECTOR');
/** 会话运行与事件 AbortSignal 协调器依赖注入 Token。 */
export const RAG_RUN_CANCELLATION = Symbol('RAG_RUN_CANCELLATION');
