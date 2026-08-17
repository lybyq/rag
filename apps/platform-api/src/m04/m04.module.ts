/**
 * M04 管理查询与人工审核 Composition Root。
 * API 进程只组装管理 Use Case，不执行结构恢复和 Chunk 算法；实际加工仍由 ingestion-worker 完成。
 *
 * @requirement KNO-011
 * @requirement KNO-012
 */
import { Module } from '@nestjs/common';
import {
  AuthorizationService,
  KNOWLEDGE_PROCESSING_REPOSITORY,
  KnowledgeProcessingAdminService,
  type KnowledgeProcessingRepository,
} from '@rag/application';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { M01Module } from '../m01/m01.module';
import {
  DocumentVersionKnowledgeRunsController,
  KnowledgeProcessingRunsController,
} from './knowledge-processing.controller';

/** 注册 M04 管理查询、审核 Use Case 与 PostgreSQL Port 实现。 */
@Module({
  imports: [M01Module, PostgresPersistenceModule],
  controllers: [DocumentVersionKnowledgeRunsController, KnowledgeProcessingRunsController],
  providers: [
    {
      provide: KnowledgeProcessingAdminService,
      inject: [KNOWLEDGE_PROCESSING_REPOSITORY, AuthorizationService],
      useFactory: (
        repository: KnowledgeProcessingRepository,
        authorization: AuthorizationService,
      ): KnowledgeProcessingAdminService =>
        new KnowledgeProcessingAdminService(repository, authorization),
    },
  ],
})
export class M04Module {}
