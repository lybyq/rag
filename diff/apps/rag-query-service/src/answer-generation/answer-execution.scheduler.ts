/**
 * 证据、生成与答案校验 数据库租约调度器。
 *
 * 多副本通过 PostgreSQL `FOR UPDATE SKIP LOCKED` 领取 ACCEPTED Run；后台恢复的用户身份必须
 * 与创建 Run 时冻结的角色摘要一致，随后所有资源仍按当前 ACL 复核。定时器只负责调度，答案
 * 规则全部位于应用服务和 LangGraph。
 *
 * @requirement ANS-003
 * @requirement ANS-015
 * @requirement OPT-015
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AUTHORIZATION_VERSION_PROVIDER,
  RAG_RUN_REPOSITORY,
  type AccessContext,
  type RagRunRepository,
} from '@rag/application';
import { rehydrateRunUserContext } from '@rag/auth';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import type { AuthorizationVersionPort } from '@rag/contracts';
import { AnswerGenerationExecutionService } from '@rag/rag-graph';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** 高频领取答案 Run；单个任务完成就补位，多进程仍由数据库租约互斥。 */
@Injectable()
export class AnswerExecutionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnswerExecutionScheduler.name);
  private readonly workerId = `${hostname()}:answer:${randomUUID()}`.slice(0, 128);
  private timer?: NodeJS.Timeout;
  /** 当前进程正在执行的 Run Promise；集合大小就是已占用执行槽。 */
  private readonly inFlight = new Set<Promise<void>>();
  /** 防止定时器与任务完成回调同时从数据库领取。 */
  private claiming = false;
  /** 优雅关闭开始后不再领取或补位。 */
  private stopping = false;
  /** 关闭期间等待尚未结束的数据库领取轮次。 */
  private claimCycle?: Promise<void>;

  public constructor(
    @Inject(RAG_RUN_REPOSITORY) private readonly repository: RagRunRepository,
    @Inject(AnswerGenerationExecutionService)
    private readonly executor: AnswerGenerationExecutionService,
    @Inject(AUTHORIZATION_VERSION_PROVIDER)
    private readonly authorizationVersion: AuthorizationVersionPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  public onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.config.answer.executionIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  public async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.claimCycle) await this.claimCycle;
    await Promise.allSettled([...this.inFlight]);
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.claiming) return;
    const availableSlots = this.config.answer.executionBatchSize - this.inFlight.size;
    if (availableSlots <= 0) return;
    this.claiming = true;
    const cycle = this.claimAndLaunch(availableSlots);
    this.claimCycle = cycle;
    try {
      await cycle;
    } catch {
      this.logger.error('证据、生成与答案校验 调度轮次失败');
    } finally {
      if (this.claimCycle === cycle) this.claimCycle = undefined;
      this.claiming = false;
    }
  }

  /** 只领取当前空闲槽位能够立即执行的数量，避免提前占住一批数据库租约。 */
  private async claimAndLaunch(availableSlots: number): Promise<void> {
    const claimed = await this.repository.claimAcceptedRuns(
      this.workerId,
      availableSlots,
      this.config.answer.executionLeaseSeconds,
    );
    if (claimed.length === 0) return;
    const currentAuthzVersion = await this.authorizationVersion.getCurrentVersion();
    for (const item of claimed) this.launch(item, currentAuthzVersion);
  }

  /**
   * 把一个已领取 Run 放入固定执行槽；完成回调先释放槽位，再触发下一次领取。
   *
   * @requirement OPT-015
   */
  private launch(
    item: Awaited<ReturnType<RagRunRepository['claimAcceptedRuns']>>[number],
    currentAuthzVersion: number,
  ): void {
    const execution = this.executeClaimed(item, currentAuthzVersion).finally(() => {
      this.inFlight.delete(execution);
      if (!this.stopping) queueMicrotask(() => void this.tick());
    });
    this.inFlight.add(execution);
  }

  /** 校验冻结身份并执行一个 Run；错误日志不复制 Provider 响应或敏感正文。 */
  private async executeClaimed(
    item: Awaited<ReturnType<RagRunRepository['claimAcceptedRuns']>>[number],
    currentAuthzVersion: number,
  ): Promise<void> {
    let user: ReturnType<typeof rehydrateRunUserContext>;
    try {
      user = rehydrateRunUserContext({
        userId: item.ownerUserId,
        roles: item.roles,
        authzVersion: item.authzVersion,
        currentAuthzVersion,
        expectedAuthzVersion: item.run.snapshot.authzVersion,
        expectedRolesSha256: item.run.snapshot.rolesSha256,
      });
    } catch {
      await this.repository
        .failRun(item.ownerUserId, item.run.id, item.run.optimisticVersion, 'RUN_IDENTITY_INVALID')
        .catch(() => undefined);
      this.logger.error('证据、生成与答案校验 Run 身份快照无效');
      return;
    }
    try {
      await this.executor.execute(userContext(user, item.run.id), item);
    } catch {
      this.logger.error('证据、生成与答案校验 Run 执行失败');
    }
  }
}

function userContext(
  user: ReturnType<typeof rehydrateRunUserContext>,
  runId: string,
): AccessContext {
  return { user, requestId: `answer-worker:${runId}` };
}
