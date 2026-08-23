/**
 * 真实评测执行的 Query Service Composition Root。
 * 复用会话/Run 服务和答案执行器，不创建第二套 RAG 链路。
 *
 * @requirement OPS-002
 * @requirement OPS-004
 */
import { Module } from '@nestjs/common';
import {
  EVALUATION_QUESTION_RUNNER,
  EVALUATION_REPOSITORY,
  EvaluationWorkerService,
  type EvaluationQuestionRunnerPort,
  type EvaluationRepository,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { ConversationRuntimeModule } from '../conversation-runtime/conversation-runtime.module';
import { EvaluationScheduler } from './evaluation.scheduler';
import { RagRunEvaluationQuestionRunner } from './evaluation-question.runner';

@Module({
  imports: [ConversationRuntimeModule, PostgresPersistenceModule],
  providers: [
    RagRunEvaluationQuestionRunner,
    { provide: EVALUATION_QUESTION_RUNNER, useExisting: RagRunEvaluationQuestionRunner },
    {
      provide: EvaluationWorkerService,
      inject: [EVALUATION_REPOSITORY, EVALUATION_QUESTION_RUNNER, APP_CONFIG],
      useFactory: (
        repository: EvaluationRepository,
        runner: EvaluationQuestionRunnerPort,
        config: AppConfig,
      ): EvaluationWorkerService =>
        new EvaluationWorkerService(repository, runner, {
          batchSize: config.evaluation.workerBatchSize,
          leaseSeconds: config.evaluation.workerLeaseSeconds,
          maxAttempts: config.evaluation.maxAttempts,
          pendingPollSeconds: config.evaluation.pendingPollSeconds,
        }),
    },
    EvaluationScheduler,
  ],
})
export class EvaluationExecutionModule {}
