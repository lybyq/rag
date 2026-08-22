/**
 * M06 面向后续 M07/M08 Graph 执行器的 Run 生命周期服务。
 *
 * 该服务提供 AbortSignal、节点审计和最终答案事务；最终答案由 Repository 先写消息与 Run，
 * 再写同事务事件 Outbox，因此 `answer.completed` 永远不会先于答案事实可见。
 *
 * @requirement RUN-005
 * @requirement RUN-006
 * @requirement RUN-010
 * @requirement RUN-011
 * @requirement RUN-012
 */
import {
  SaveConversationStateInputSchema,
  type ConversationState,
  type RagRun,
  type RagRunStep,
  type SaveConversationStateInput,
} from '@rag/contracts';
import { ApplicationError } from './application.error';
import type {
  FinishRagRunStepCommand,
  RagRunCancellationPort,
  RagRunRepository,
  SensitiveTextProtectorPort,
  StartRagRunStepCommand,
  UpdateConversationStateCommand,
} from './rag-run.ports';

/** Graph 执行器使用的答案与保留期配置。 */
export interface RagRunLifecycleConfig {
  readonly contentRetentionDays: number;
}

/** Run 生命周期与节点审计应用服务。 */
export class RagRunLifecycleService {
  public constructor(
    private readonly repository: RagRunRepository,
    private readonly protector: SensitiveTextProtectorPort,
    private readonly cancellation: RagRunCancellationPort,
    private readonly config: RagRunLifecycleConfig,
  ) {}

  /** 开始 Run 并返回必须继续向下游传播的 AbortSignal。 */
  public async start(
    ownerUserId: string,
    runId: string,
    expectedVersion: number,
  ): Promise<{ readonly run: RagRun; readonly signal: AbortSignal }> {
    return {
      run: await this.repository.startRun(ownerUserId, runId, expectedVersion),
      signal: this.cancellation.signal(runId),
    };
  }

  /** 开始记录一个 Graph 节点。 */
  public startStep(runId: string, command: StartRagRunStepCommand): Promise<RagRunStep> {
    return this.repository.startStep(runId, command);
  }

  /** 完成 Graph 节点并保存脱敏摘要。 */
  public finishStep(runId: string, command: FinishRagRunStepCommand): Promise<RagRunStep> {
    return this.repository.finishStep(runId, command);
  }

  /**
   * 乐观锁更新摘要、实体和最近引用。
   * 摘要沿用正文保护策略；来源空间单独保存，读取时才能在撤权后 fail-closed。
   */
  public async saveConversationState(
    ownerUserId: string,
    conversationId: string,
    expectedVersion: number,
    input: SaveConversationStateInput,
  ): Promise<ConversationState> {
    const parsed = SaveConversationStateInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ApplicationError('SCHEMA_MISMATCH', 409, '会话状态不符合有限记忆契约');
    }
    const command: UpdateConversationStateCommand = {
      expectedVersion,
      summary: parsed.data.summary === null ? null : this.protector.protect(parsed.data.summary),
      retentionExpiresAt: new Date(Date.now() + this.config.contentRetentionDays * 86_400_000),
      summarySourceSpaceIds: [...new Set(parsed.data.summarySourceSpaceIds)],
      confirmedEntities: [...new Set(parsed.data.confirmedEntities)],
      recentCitationIds: [...new Set(parsed.data.recentCitationIds)],
    };
    const stored = await this.repository.updateConversationState(
      ownerUserId,
      conversationId,
      command,
    );
    return {
      conversationId: stored.conversationId,
      optimisticVersion: stored.optimisticVersion,
      summary: stored.protectedSummary ? this.protector.reveal(stored.protectedSummary) : null,
      confirmedEntities: stored.confirmedEntities,
      recentCitationIds: stored.recentCitationIds,
      shortWindowMessageIds: stored.shortWindowMessageIds,
      updatedAt: stored.updatedAt,
    };
  }

  /** 最终答案先持久化，随后只由 Outbox Publisher 发布完成事件。 */
  public async complete(
    ownerUserId: string,
    runId: string,
    expectedVersion: number,
    answer: string,
    citationsSummary?: Readonly<Record<string, unknown>>,
  ): Promise<RagRun> {
    const run = await this.repository.completeRun(ownerUserId, runId, {
      expectedVersion,
      answer: this.protector.protect(answer),
      retentionExpiresAt: new Date(Date.now() + this.config.contentRetentionDays * 86_400_000),
      ...(citationsSummary ? { citationsSummary } : {}),
    });
    this.cancellation.release(runId);
    return run;
  }

  /** 稳定失败码替代 Provider 原始响应。 */
  public async fail(
    ownerUserId: string,
    runId: string,
    expectedVersion: number,
    code: string,
  ): Promise<RagRun> {
    const run = await this.repository.failRun(ownerUserId, runId, expectedVersion, code);
    this.cancellation.release(runId);
    return run;
  }

  /** 下游捕获取消后确认终态。 */
  public async finalizeCancellation(
    ownerUserId: string,
    runId: string,
    expectedVersion: number,
  ): Promise<RagRun> {
    const run = await this.repository.finalizeCancellation(ownerUserId, runId, expectedVersion);
    this.cancellation.release(runId);
    return run;
  }
}
