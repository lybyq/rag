/** PostgreSQL Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import {
  AUTHORIZATION_VERSION_PROVIDER,
  KNOWLEDGE_SPACE_REPOSITORY,
  SECURITY_AUDIT,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { Pool } from 'pg';
import { PostgresAuthorizationVersionProvider } from './postgres-authorization-version.provider';
import { PostgresKnowledgeSpaceRepository } from './postgres-knowledge-space.repository';
import { PostgresPoolLifecycle } from './postgres-pool.lifecycle';
import { PostgresSecurityAuditAdapter } from './postgres-security-audit.adapter';
import { PostgresHealthProbe } from './postgres-health.probe';
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
    PostgresSecurityAuditAdapter,
    { provide: AUTHORIZATION_VERSION_PROVIDER, useExisting: PostgresAuthorizationVersionProvider },
    { provide: KNOWLEDGE_SPACE_REPOSITORY, useExisting: PostgresKnowledgeSpaceRepository },
    { provide: SECURITY_AUDIT, useExisting: PostgresSecurityAuditAdapter },
  ],
  exports: [
    POSTGRES_POOL,
    PostgresHealthProbe,
    AUTHORIZATION_VERSION_PROVIDER,
    KNOWLEDGE_SPACE_REPOSITORY,
    SECURITY_AUDIT,
  ],
})
export class PostgresPersistenceModule {}
