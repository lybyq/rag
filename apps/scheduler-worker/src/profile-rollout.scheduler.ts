/**
 * M05 Profile 重建与离线评测调度器。
 * 数据库 lease 让多个内网 Scheduler 实例可安全并行；单进程 tick 不重入。
 *
 * @requirement IDX-016
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  EMBEDDING_PORT,
  PROFILE_ROLLOUT_REPOSITORY,
  VECTOR_INDEX_PORT,
  ProfileRolloutService,
  type EmbeddingPort,
  type ProfileRolloutRepository,
  type VectorIndexPort,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { MetricsService } from '@rag/observability';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/** 自动驱动 QUEUED→BUILDING 和 EVALUATING→READY/PUBLISHED 状态迁移。 */
@Injectable()
export class ProfileRolloutScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProfileRolloutScheduler.name);
  private readonly workerId = `${hostname()}:profile-rollout:${randomUUID()}`.slice(0, 128);
  private readonly service: ProfileRolloutService;
  private timer?: NodeJS.Timeout;
  private running = false;

  public constructor(
    @Inject(PROFILE_ROLLOUT_REPOSITORY)
    private readonly repository: ProfileRolloutRepository,
    @Inject(EMBEDDING_PORT) embedding: EmbeddingPort,
    @Inject(VECTOR_INDEX_PORT) vectorIndex: VectorIndexPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {
    this.service = new ProfileRolloutService(repository, embedding, vectorIndex, {
      profile: {
        profileId: config.embedding.profileId,
        providerProfile: config.providerProfile,
        provider: config.embedding.providerName,
        modelId: config.embedding.modelId,
        revision: config.embedding.revision,
        protocolVersion: config.embedding.protocolVersion,
        tokenizerRevision: config.embedding.tokenizerRevision,
        denseDimension: config.embedding.denseDimension,
        normalizeDense: config.embedding.normalizeDense,
        sparseFormatVersion: config.embedding.outputModes.includes('sparse')
          ? config.embedding.sparseFormatVersion
          : null,
        documentTemplateVersion: config.embedding.documentTemplateVersion,
        queryTemplateVersion: config.embedding.queryTemplateVersion,
        maxInputTokens: config.embedding.maxInputTokens,
        maxBatchSize: config.embedding.batchSize,
      },
      requestTimeoutMs: config.embedding.requestTimeoutMs,
      overallDeadlineMs: config.indexing.overallDeadlineMs,
      maxCases: config.indexing.rolloutMaxCases,
      evaluationTopK: config.indexing.rolloutEvaluationTopK,
      minimumRecall: config.indexing.rolloutMinimumRecall,
      maxAttempts: config.indexing.rolloutMaxAttempts,
      retryBaseDelayMs: config.embedding.retryBaseDelayMs,
    });
  }

  public onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), 15_000);
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
      const tasks = await this.repository.claimProfileRebuildTasks(
        this.workerId,
        2,
        this.config.indexing.rolloutLeaseSeconds,
      );
      for (const task of tasks) {
        const outcome = await this.service.process(task, this.workerId);
        this.metrics.m05OperationsTotal.inc({
          operation: `profile_${task.action.toLowerCase()}`,
          result: outcome.toLowerCase(),
        });
      }
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : 'unknown' },
        'M05 Profile rollout 调度失败',
      );
      this.metrics.m05OperationsTotal.inc({ operation: 'profile_rollout_tick', result: 'failure' });
    } finally {
      this.running = false;
    }
  }
}
