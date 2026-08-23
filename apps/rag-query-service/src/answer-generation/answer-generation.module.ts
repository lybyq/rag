/**
 * 证据、生成与答案校验 Query Service Composition Root。
 *
 * 本模块组装混合检索子图、Reranker、答案模型、PostgreSQL 证据源、运行生命周期和后台调度。
 * 外网与内网差异只由 Provider Gateway 读取配置，答案业务图不感知 DeepSeek 或内网协议。
 *
 * @requirement ANS-001
 * @requirement ANS-002
 * @requirement ANS-015
 */
import { Module } from '@nestjs/common';
import {
  ANSWER_GENERATION_TELEMETRY,
  ANSWER_MODEL_PORT,
  EVIDENCE_SOURCE_REPOSITORY,
  RERANKER_PORT,
  RagRunLifecycleService,
  type AnswerGenerationTelemetryPort,
  type AnswerModelPort,
  type EvidenceSourceRepository,
  type RerankerPort,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { AnswerModelGatewayModule, RerankerGatewayModule } from '@rag/model-gateway';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { AnswerGenerationExecutionService, HybridRetrievalService } from '@rag/rag-graph';
import { ConversationRuntimeModule } from '../conversation-runtime/conversation-runtime.module';
import { HybridRetrievalModule } from '../hybrid-retrieval/hybrid-retrieval.module';
import { AnswerExecutionScheduler } from './answer-execution.scheduler';
import { AnswerGenerationTelemetryAdapter } from './answer-generation-telemetry.adapter';
import { CitationsController } from './citations.controller';

/** 答案阶段的完整 NestJS 模块。 */
@Module({
  imports: [
    ConversationRuntimeModule,
    HybridRetrievalModule,
    PostgresPersistenceModule,
    RerankerGatewayModule,
    AnswerModelGatewayModule,
  ],
  controllers: [CitationsController],
  providers: [
    AnswerGenerationTelemetryAdapter,
    { provide: ANSWER_GENERATION_TELEMETRY, useExisting: AnswerGenerationTelemetryAdapter },
    {
      provide: AnswerGenerationExecutionService,
      inject: [
        HybridRetrievalService,
        RERANKER_PORT,
        EVIDENCE_SOURCE_REPOSITORY,
        ANSWER_MODEL_PORT,
        ANSWER_GENERATION_TELEMETRY,
        RagRunLifecycleService,
        APP_CONFIG,
      ],
      useFactory: (
        retrieval: HybridRetrievalService,
        reranker: RerankerPort,
        evidenceSource: EvidenceSourceRepository,
        model: AnswerModelPort,
        telemetry: AnswerGenerationTelemetryPort,
        lifecycle: RagRunLifecycleService,
        config: AppConfig,
      ): AnswerGenerationExecutionService =>
        new AnswerGenerationExecutionService(
          {
            retrieval,
            reranker,
            evidenceSource,
            model,
            telemetry,
            config: {
              rerankerTimeoutMs: config.reranker.requestTimeoutMs,
              llmTimeoutMs: config.llm.requestTimeoutMs,
              rerankerMaximumCandidates: config.reranker.maxCandidates,
              rerankerTopN: config.reranker.topN,
              rerankFallbackEnabled: config.answer.rerankFallbackEnabled,
              llmEvidenceRerankEnabled: config.answer.llmEvidenceRerankEnabled,
              semanticJudgeEnabled: config.answer.semanticJudgeEnabled,
              contextTokenBudget: config.answer.contextTokenBudget,
              contextMaximumPerDocument: config.answer.contextMaxPerDocument,
              minimumConfidence: config.answer.minimumConfidence,
              validatorProfileId: config.run.validatorProfileId,
              expectedRerankerRevision: config.reranker.revision,
            },
          },
          lifecycle,
          { llmModelId: config.llm.modelId },
        ),
    },
    AnswerExecutionScheduler,
  ],
})
export class AnswerGenerationModule {}
