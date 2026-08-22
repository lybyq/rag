/**
 * M06 会话、Run 创建、事件读取、取消、Ticket 与反馈应用服务。
 *
 * 创建 Run 只完成授权、快照和 PostgreSQL 事务，因此快速返回；不会同步调用模型。
 * 历史消息每次读取都会重新校验其来源空间，撤权后安全脱敏。
 *
 * @requirement RUN-002
 * @requirement RUN-003
 * @requirement RUN-004
 * @requirement RUN-008
 * @requirement RUN-009
 * @requirement RUN-010
 * @requirement RUN-012
 * @requirement RUN-013
 * @requirement RUN-014
 */
import type {
  Conversation,
  ConversationMessage,
  ConversationState,
  CreateConversationRequest,
  CreateMessageFeedbackRequest,
  CreateRagRunAccepted,
  CreateRagRunRequest,
  ListConversationsQuery,
  MessageFeedback,
  RagRun,
  RagRunEventPage,
  RagRunSnapshot,
  RagRunStep,
  RunStreamTicket,
} from '@rag/contracts';
import { selectCanaryManifest } from '@rag/retrieval';
import { createHash } from 'node:crypto';
import { ApplicationError } from './application.error';
import type { AuthorizationService } from './authorization.service';
import type { AccessContext } from './ports';
import type {
  ConversationPage,
  RagRunCancellationPort,
  RagRunEventStreamPort,
  RagRunStreamPage,
  RagRunRepository,
  SensitiveTextProtectorPort,
  StoredConversationMessage,
} from './rag-run.ports';

/** Run 创建时冻结的配置和合规保留策略。 */
export interface RagRunServiceConfig {
  readonly flowVersion: string;
  readonly policyVersion: string;
  readonly promptProfileId: string;
  readonly validatorProfileId: string;
  readonly embeddingProfileId: string;
  readonly embeddingRevision: string;
  readonly rerankerProfileId: string;
  readonly rerankerRevision: string;
  readonly llmProfileId: string;
  readonly llmRevision: string;
  readonly deadlineSeconds: number;
  readonly eventRetentionSeconds: number;
  readonly contentRetentionDays: number;
  readonly streamTicketTtlSeconds: number;
  readonly shortWindowMessages: number;
}

/** Ticket 兑换后的可信绑定和 PG Run 快照。 */
export interface RedeemedRunStream {
  readonly userId: string;
  readonly run: RagRun;
}

/** M06 面向 HTTP Controller 的应用入口。 */
export class RagRunService {
  public constructor(
    private readonly repository: RagRunRepository,
    private readonly authorization: AuthorizationService,
    private readonly protector: SensitiveTextProtectorPort,
    private readonly eventStream: RagRunEventStreamPort,
    private readonly cancellation: RagRunCancellationPort,
    private readonly config: RagRunServiceConfig,
  ) {}

  /** 创建只属于当前 userId 的会话；标题不从问题正文自动推导。 */
  public createConversation(
    context: AccessContext,
    request: CreateConversationRequest,
  ): Promise<Conversation> {
    return this.repository.createConversation(context, {
      ownerUserId: context.user.userId,
      title: request.title ?? '新会话',
    });
  }

  /** 分页读取当前用户会话。 */
  public listConversations(
    context: AccessContext,
    query: ListConversationsQuery,
  ): Promise<ConversationPage> {
    return this.repository.listConversations(context, query);
  }

  /**
   * 幂等创建 Run：先缩小空间范围并冻结 Manifest，再保护问题正文，最后一次 PG 事务落事实。
   * 相同 Idempotency-Key + 相同请求返回原 Run；同 Key 不同请求返回冲突。
   */
  public async createRun(
    context: AccessContext,
    conversationId: string,
    idempotencyKey: string,
    request: CreateRagRunRequest,
  ): Promise<CreateRagRunAccepted> {
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    await this.repository.getConversation(context, conversationId);
    const requested = [...new Set(request.requestedSpaceIds)].sort();
    const allowed = await this.authorization.restrictRequestedSpaces(context, requested);
    if (allowed.length === 0)
      throw new ApplicationError('ACCESS_DENIED', 403, '没有可用于问答的知识空间');

    const routes = await this.repository.resolvePublicationRoutes(allowed);
    if (routes.length !== allowed.length) {
      throw new ApplicationError('INVALID_STATE', 409, '部分知识空间尚未发布可检索版本');
    }
    const manifests = routes.map((route) => {
      if (!route.candidate || route.canaryPercent === undefined || !route.canarySalt) {
        return route.stable;
      }
      const selectedId = selectCanaryManifest(context.user.userId, {
        stableManifestId: route.stable.manifestId,
        candidateManifestId: route.candidate.manifestId,
        canaryPercent: route.canaryPercent,
        routingSalt: route.canarySalt,
      });
      return selectedId === route.candidate.manifestId ? route.candidate : route.stable;
    });
    const snapshot: RagRunSnapshot = {
      flowVersion: this.config.flowVersion,
      policyVersion: this.config.policyVersion,
      promptProfileId: this.config.promptProfileId,
      embeddingProfileId: this.config.embeddingProfileId,
      embeddingRevision: this.config.embeddingRevision,
      rerankerProfileId: this.config.rerankerProfileId,
      rerankerRevision: this.config.rerankerRevision,
      llmProfileId: this.config.llmProfileId,
      llmRevision: this.config.llmRevision,
      validatorProfileId: this.config.validatorProfileId,
      manifests,
      authzVersion: context.user.authzVersion,
      rolesSha256: createHash('sha256')
        .update([...context.user.roles].sort().join('\u001f'))
        .digest('hex'),
    };
    const now = Date.now();
    const result = await this.repository.createRun(context, {
      conversationId,
      ownerUserId: context.user.userId,
      idempotencyKey: normalizedKey,
      requestSha256: createRequestSha256(conversationId, request.question, requested),
      question: this.protector.protect(request.question),
      snapshot,
      deadlineAt: new Date(now + this.config.deadlineSeconds * 1_000),
      eventExpiresAt: new Date(now + this.config.eventRetentionSeconds * 1_000),
      retentionExpiresAt: new Date(now + this.config.contentRetentionDays * 86_400_000),
      ...(context.traceId ? { traceId: context.traceId } : {}),
    });
    return {
      run: result.run,
      eventsUrl: `/api/v1/runs/${result.run.id}/events`,
      ticketUrl: `/api/v1/runs/${result.run.id}/stream-ticket`,
      expiresAt: result.run.eventExpiresAt,
      replayed: result.replayed,
    };
  }

  /** 读取当前用户 Run。 */
  public getRun(context: AccessContext, runId: string): Promise<RagRun> {
    return this.repository.getRun(context, runId);
  }

  /** 读取 Graph 节点审计摘要。 */
  public listRunSteps(context: AccessContext, runId: string): Promise<readonly RagRunStep[]> {
    return this.repository.listRunSteps(context, runId);
  }

  /** 取消事实先写 PG，再立即中止本实例；Outbox 投递后其他实例也会收到广播。 */
  public async cancelRun(context: AccessContext, runId: string, reason: string): Promise<RagRun> {
    const run = await this.repository.requestCancellation(context, runId, reason);
    this.cancellation.cancel(run.id, '用户请求取消 Run');
    return run;
  }

  /** 为已鉴权用户签发绑定 runId + userId 的短时一次性 Ticket。 */
  public async issueStreamTicket(context: AccessContext, runId: string): Promise<RunStreamTicket> {
    await this.repository.getRun(context, runId);
    const ticket = await this.eventStream.issueTicket(
      { runId, userId: context.user.userId },
      this.config.streamTicketTtlSeconds,
    );
    return {
      ticket,
      streamUrl: `/api/v1/run-streams/${runId}`,
      expiresAt: new Date(Date.now() + this.config.streamTicketTtlSeconds * 1_000).toISOString(),
    };
  }

  /** Ticket 使用 GETDEL 语义兑换；错误统一返回不存在，避免枚举 runId。 */
  public async redeemStreamTicket(ticket: string, runId: string): Promise<RedeemedRunStream> {
    const binding = await this.eventStream.redeemTicket(ticket);
    if (!binding || binding.runId !== runId) {
      throw new ApplicationError('NOT_FOUND', 404, 'Stream Ticket 不存在或已过期');
    }
    return {
      userId: binding.userId,
      run: await this.repository.getRunByOwner(binding.userId, runId),
    };
  }

  /** 已认证轮询降级；Stream 过期时仍返回 PostgreSQL Run 终态。 */
  public async listEvents(
    context: AccessContext,
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<RagRunEventPage> {
    const run = await this.repository.getRun(context, runId);
    let page: RagRunStreamPage;
    try {
      page = await this.eventStream.read(runId, afterSequence, limit);
    } catch {
      // Redis 只是事件投影；不可用时仍必须返回 PG Run 事实，客户端可安全切换到状态轮询。
      page = { items: [], nextSequence: afterSequence, exists: false };
    }
    return {
      items: [...page.items],
      nextSequence: page.nextSequence,
      streamExpired:
        !page.exists &&
        (isTerminalStatus(run.status) || Date.now() >= new Date(run.eventExpiresAt).getTime()),
      run,
    };
  }

  /** Ticket 已兑换后的可信 owner 读取；Controller 不接受客户端传入 userId。 */
  public getTicketRun(ownerUserId: string, runId: string): Promise<RagRun> {
    return this.repository.getRunByOwner(ownerUserId, runId);
  }

  /** Ticket SSE 使用的事件读取，授权已由一次性绑定完成。 */
  public async readTicketEvents(
    runId: string,
    afterSequence: number,
    limit: number,
  ): Promise<RagRunStreamPage> {
    try {
      return await this.eventStream.read(runId, afterSequence, limit);
    } catch {
      return { items: [], nextSequence: afterSequence, exists: false };
    }
  }

  /** 读取短窗口，并对历史答案的来源空间重新鉴权。 */
  public async listMessages(
    context: AccessContext,
    conversationId: string,
  ): Promise<{
    readonly items: readonly ConversationMessage[];
    readonly state: ConversationState;
  }> {
    const stored = await this.repository.listMessages(
      context,
      conversationId,
      this.config.shortWindowMessages,
    );
    const items: ConversationMessage[] = [];
    for (const message of stored.items) items.push(await this.toVisibleMessage(context, message));
    const summaryAllowed = await this.canReadAllSpaces(context, stored.state.summarySourceSpaceIds);
    return {
      items,
      state: {
        conversationId: stored.state.conversationId,
        optimisticVersion: stored.state.optimisticVersion,
        summary:
          summaryAllowed && stored.state.protectedSummary
            ? this.protector.reveal(stored.state.protectedSummary)
            : null,
        // 摘要、实体和引用属于同一有限记忆快照；任一来源撤权时整体 fail-closed。
        confirmedEntities: summaryAllowed ? stored.state.confirmedEntities : [],
        recentCitationIds: summaryAllowed ? stored.state.recentCitationIds : [],
        shortWindowMessageIds: stored.state.shortWindowMessageIds,
        updatedAt: stored.state.updatedAt,
      },
    };
  }

  /** 保存或覆盖当前用户对自己助手消息的反馈。 */
  public saveFeedback(
    context: AccessContext,
    messageId: string,
    feedback: CreateMessageFeedbackRequest,
  ): Promise<MessageFeedback> {
    return this.repository.saveFeedback(context, messageId, feedback);
  }

  private async toVisibleMessage(
    context: AccessContext,
    message: StoredConversationMessage,
  ): Promise<ConversationMessage> {
    const sourceSpaceIds = extractSourceSpaceIds(message.citationsSummary);
    if (sourceSpaceIds.length > 0) {
      const allowed = await this.authorization.restrictRequestedSpaces(context, sourceSpaceIds);
      if (allowed.length !== sourceSpaceIds.length) {
        return {
          ...withoutProtected(message),
          status: 'REDACTED',
          content: null,
          contentStoredAs: 'REDACTED',
          citationsSummary: null,
        };
      }
    }
    return {
      ...withoutProtected(message),
      content: this.protector.reveal(message.protectedContent),
      contentStoredAs: message.protectedContent.storage,
    };
  }

  private async canReadAllSpaces(
    context: AccessContext,
    sourceSpaceIds: readonly string[],
  ): Promise<boolean> {
    if (sourceSpaceIds.length === 0) return true;
    const allowed = await this.authorization.restrictRequestedSpaces(context, sourceSpaceIds);
    return allowed.length === sourceSpaceIds.length;
  }
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(normalized)) {
    throw new ApplicationError('INVALID_STATE', 409, 'Idempotency-Key 格式非法');
  }
  return normalized;
}

function createRequestSha256(
  conversationId: string,
  question: string,
  requestedSpaceIds: readonly string[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        conversationId,
        question,
        requestedSpaceIds: [...requestedSpaceIds].sort(),
      }),
    )
    .digest('hex');
}

function extractSourceSpaceIds(value: Readonly<Record<string, unknown>> | null): readonly string[] {
  const raw = value?.['spaceIds'];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

function isTerminalStatus(status: RagRun['status']): boolean {
  return ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status);
}

function withoutProtected(
  message: StoredConversationMessage,
): Omit<ConversationMessage, 'content' | 'contentStoredAs'> {
  const { protectedContent, ...publicFields } = message;
  void protectedContent;
  return publicFields;
}
