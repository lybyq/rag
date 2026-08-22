/** PostgreSQL Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import {
  AUTHORIZATION_VERSION_PROVIDER,
  DOCUMENT_INGESTION_REPOSITORY,
  DOCUMENT_PROCESSING_REPOSITORY,
  INDEXING_REPOSITORY,
  INDEX_MAINTENANCE_REPOSITORY,
  KNOWLEDGE_PROCESSING_REPOSITORY,
  KNOWLEDGE_SPACE_REPOSITORY,
  PROFILE_ROLLOUT_REPOSITORY,
  SECURITY_AUDIT,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { Pool } from 'pg';
import { PostgresAuthorizationVersionProvider } from './postgres-authorization-version.provider';
import { PostgresKnowledgeSpaceRepository } from './postgres-knowledge-space.repository';
import { PostgresPoolLifecycle } from './postgres-pool.lifecycle';
import { PostgresSecurityAuditAdapter } from './postgres-security-audit.adapter';
import { PostgresHealthProbe } from './postgres-health.probe';
import { PostgresDocumentIngestionRepository } from './postgres-document-ingestion.repository';
import { PostgresDocumentProcessingRepository } from './postgres-document-processing.repository';
import { PostgresIndexingRepository } from './postgres-indexing.repository';
import { PostgresKnowledgeProcessingRepository } from './postgres-knowledge-processing.repository';
import { POSTGRES_POOL } from './postgres.tokens';

@Module({
  providers: [
    {
      provide: POSTGRES_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Pool =>
        new Pool({
          connectionString: config.databaseUrl,
          connectionTimeoutMillis: config.dependencyHealthTimeoutMs,
          max: 12,
        }),
    },
    PostgresPoolLifecycle,
    PostgresHealthProbe,
    PostgresAuthorizationVersionProvider,
    PostgresKnowledgeSpaceRepository,
    PostgresDocumentIngestionRepository,
    PostgresDocumentProcessingRepository,
    PostgresIndexingRepository,
    PostgresKnowledgeProcessingRepository,
    PostgresSecurityAuditAdapter,
    { provide: AUTHORIZATION_VERSION_PROVIDER, useExisting: PostgresAuthorizationVersionProvider },
    { provide: KNOWLEDGE_SPACE_REPOSITORY, useExisting: PostgresKnowledgeSpaceRepository },
    { provide: SECURITY_AUDIT, useExisting: PostgresSecurityAuditAdapter },
    { provide: DOCUMENT_INGESTION_REPOSITORY, useExisting: PostgresDocumentIngestionRepository },
    { provide: DOCUMENT_PROCESSING_REPOSITORY, useExisting: PostgresDocumentProcessingRepository },
    {
      provide: KNOWLEDGE_PROCESSING_REPOSITORY,
      useExisting: PostgresKnowledgeProcessingRepository,
    },
    { provide: INDEXING_REPOSITORY, useExisting: PostgresIndexingRepository },
    { provide: INDEX_MAINTENANCE_REPOSITORY, useExisting: PostgresIndexingRepository },
    { provide: PROFILE_ROLLOUT_REPOSITORY, useExisting: PostgresIndexingRepository },
  ],
  exports: [
    POSTGRES_POOL,
    PostgresHealthProbe,
    AUTHORIZATION_VERSION_PROVIDER,
    KNOWLEDGE_SPACE_REPOSITORY,
    SECURITY_AUDIT,
    DOCUMENT_INGESTION_REPOSITORY,
    DOCUMENT_PROCESSING_REPOSITORY,
    KNOWLEDGE_PROCESSING_REPOSITORY,
    INDEXING_REPOSITORY,
    INDEX_MAINTENANCE_REPOSITORY,
    PROFILE_ROLLOUT_REPOSITORY,
  ],
})
export class PostgresPersistenceModule {}
