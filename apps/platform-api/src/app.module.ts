/** 平台管理 API 根模块；后续接入知识空间、文档和任务管理用例。 */
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '@rag/config';
import { HealthModule } from '@rag/health';
import { ObservabilityModule } from '@rag/observability';
import { IdentityAccessModule } from './identity-access/identity-access.module';
import { DocumentIngestionModule } from './document-ingestion/document-ingestion.module';
import { DocumentParsingModule } from './document-parsing/document-parsing.module';
import { KnowledgeProcessingModule } from './knowledge-processing/knowledge-processing.module';
import { IndexingPublicationModule } from './indexing-publication/indexing-publication.module';

@Module({
  imports: [
    RuntimeConfigModule,
    ObservabilityModule,
    HealthModule,
    IdentityAccessModule,
    DocumentIngestionModule,
    DocumentParsingModule,
    KnowledgeProcessingModule,
    IndexingPublicationModule,
  ],
})
export class PlatformApiModule {}
