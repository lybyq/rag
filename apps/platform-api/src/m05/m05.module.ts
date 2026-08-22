/**
 * M05 Platform API Composition Root。
 * API 只装配管理 Use Case；Embedding 和 Milvus 写入仍由 ingestion-worker 完成。
 *
 * @requirement IDX-010
 * @requirement IDX-016
 */
import { Module } from '@nestjs/common';
import {
  INDEXING_REPOSITORY,
  IndexingAdminService,
  type IndexingRepository,
} from '@rag/application';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { IndexingRunsController, SpaceIndexController } from './indexing.controller';

/** 注册 M05 管理 API 和 PostgreSQL 端口实现。 */
@Module({
  imports: [PostgresPersistenceModule],
  controllers: [IndexingRunsController, SpaceIndexController],
  providers: [
    {
      provide: IndexingAdminService,
      inject: [INDEXING_REPOSITORY],
      useFactory: (repository: IndexingRepository): IndexingAdminService =>
        new IndexingAdminService(repository),
    },
  ],
})
export class M05Module {}
