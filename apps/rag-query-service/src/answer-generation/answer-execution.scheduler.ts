/**
 * 证据、生成与答案校验 数据库租约调度器。
 *
 * 多副本通过 PostgreSQL `FOR UPDATE SKIP LOCKED` 领取 ACCEPTED Run；后台恢复的用户身份必须
 * 与创建 Run 时冻结的角色摘要一致，随后所有资源仍按当前 ACL 复核。定时器只负责调度，答案
 * 规则全部位于应用服务和 LangGraph。
 *
 * @requirement ANS-003
 * @requirement ANS-015
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

/** 高频领取答案 Run，单进程不重入，多进程由数据库租约互斥。 */
@Injectable()
export class AnswerExecutionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnswerExecutionScheduler.name);
  private readonly workerId = `${hostname()}:answer:${randomUUID()}`.slice(0, 128);
  private timer?: NodeJS.Timeout;
  private running = false;

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

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const claimed = await this.repository.claimAcceptedRuns(
        this.workerId,
        this.config.answer.executionBatchSize,
        this.config.answer.executionLeaseSeconds,
      );
      const currentAuthzVersion = await this.authorizationVersion.getCurrentVersion();
      await Promise.all(
        claimed.map(async (item) => {
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
              .failRun(
                item.ownerUserId,
                item.run.id,
                item.run.optimisticVersion,
                'RUN_IDENTITY_INVALID',
              )
              .catch(() => undefined);
            this.logger.error('证据、生成与答案校验 Run 身份快照无效');
            return;
          }
          try {
            await this.executor.execute(userContext(user, item.run.id), item);
          } catch {
            // 执行服务会尽力写入稳定终态；调度器日志不复制 Provider 错误或正文。
            this.logger.error('证据、生成与答案校验 Run 执行失败');
          }
        }),
      );
    } catch {
      this.logger.error('证据、生成与答案校验 调度轮次失败');
    } finally {
      this.running = false;
    }
  }
}

function userContext(
  user: ReturnType<typeof rehydrateRunUserContext>,
  runId: string,
): AccessContext {
  return { user, requestId: `answer-worker:${runId}` };
}
