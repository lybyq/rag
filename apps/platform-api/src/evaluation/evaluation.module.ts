/**
 * 评测管理面的 NestJS Composition Root。
 * 这里只组装应用服务、身份授权和 PostgreSQL Port，不启动执行 Worker。
 *
 * @requirement OPS-001
 * @requirement OPS-004
 */
import { Module } from '@nestjs/common';
import {
  AuthorizationService,
  EVALUATION_REPOSITORY,
  EvaluationService,
  type EvaluationRepository,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { IdentityAccessModule } from '../identity-access/identity-access.module';
import { EvaluationDatasetsController, EvaluationRunsController } from './evaluation.controller';

@Module({
  imports: [IdentityAccessModule, PostgresPersistenceModule],
  controllers: [EvaluationDatasetsController, EvaluationRunsController],
  providers: [
    {
      provide: EvaluationService,
      inject: [EVALUATION_REPOSITORY, APP_CONFIG, AuthorizationService],
      useFactory: (
        repository: EvaluationRepository,
        config: AppConfig,
        authorization: AuthorizationService,
      ): EvaluationService =>
        new EvaluationService(
          repository,
          {
            flowVersion: config.run.flowVersion,
            policyVersion: config.run.policyVersion,
            promptProfileId: config.run.promptProfileId,
            embeddingProfileId: config.embedding.profileId,
            embeddingRevision: config.embedding.revision,
            rerankerProfileId: config.reranker.profileId,
            rerankerRevision: config.reranker.revision,
            llmProfileId: config.llm.profileId,
            llmRevision: config.llm.revision,
            validatorProfileId: config.run.validatorProfileId,
          },
          authorization,
        ),
    },
  ],
})
export class EvaluationModule {}
