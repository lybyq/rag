/** M02 在 Platform API 中的 Composition Root。 */
import { Module } from '@nestjs/common';
import {
  DOCUMENT_INGESTION_REPOSITORY,
  DocumentIngestionService,
  OBJECT_STORAGE,
  SECURITY_AUDIT,
  AuthorizationService,
  type DocumentIngestionRepository,
  type ObjectStoragePort,
  type SecurityAuditPort,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { MinioPersistenceModule } from '@rag/persistence-minio';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { M01Module } from '../m01/m01.module';
import { DocumentsController, SpaceDocumentsController } from './documents.controller';
import { IngestionJobsController } from './ingestion-jobs.controller';
import { UploadsController } from './uploads.controller';

@Module({
  imports: [M01Module, PostgresPersistenceModule, MinioPersistenceModule],
  controllers: [
    UploadsController,
    SpaceDocumentsController,
    DocumentsController,
    IngestionJobsController,
  ],
  providers: [
    {
      provide: DocumentIngestionService,
      inject: [
        DOCUMENT_INGESTION_REPOSITORY,
        OBJECT_STORAGE,
        AuthorizationService,
        SECURITY_AUDIT,
        APP_CONFIG,
      ],
      useFactory: (
        repository: DocumentIngestionRepository,
        storage: ObjectStoragePort,
        authorization: AuthorizationService,
        audit: SecurityAuditPort,
        config: AppConfig,
      ): DocumentIngestionService =>
        new DocumentIngestionService(repository, storage, authorization, audit, {
          bucket: config.minio.uploadBucket,
          sessionTtlSeconds: config.upload.sessionTtlSeconds,
          presignedUrlTtlSeconds: config.upload.presignedUrlTtlSeconds,
          maxFilesPerSession: config.upload.maxFilesPerSession,
          maxFileBytes: config.upload.maxFileBytes,
          multipartThresholdBytes: config.upload.multipartThresholdBytes,
          partSizeBytes: config.upload.partSizeBytes,
          externalCallTimeoutMs: config.dependencyHealthTimeoutMs * 2,
        }),
    },
  ],
})
export class M02Module {}
