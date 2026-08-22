/**
 * M06 rag-query-service Composition Root。
 *
 * 本模块复用 M01 的三种认证 Adapter 与授权服务，组装 PG 事实源、Redis Stream、
 * AES-GCM 正文保护、Run 生命周期和调度器；业务类不读取供应商环境变量。
 *
 * @requirement RUN-001
 * @requirement RUN-007
 * @requirement RUN-008
 * @requirement RUN-010
 * @requirement RUN-014
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  AUTHORIZATION_CACHE,
  AUTHORIZATION_VERSION_PROVIDER,
  AuthorizationService,
  KNOWLEDGE_SPACE_REPOSITORY,
  RAG_RUN_CANCELLATION,
  RAG_RUN_EVENT_STREAM,
  RAG_RUN_REPOSITORY,
  RagRunEventPublisherService,
  RagRunLifecycleService,
  RagRunMaintenanceService,
  RagRunService,
  SECURITY_AUDIT,
  SENSITIVE_TEXT_PROTECTOR,
  type AuthorizationCachePort,
  type RagRunCancellationPort,
  type RagRunEventStreamPort,
  type RagRunRepository,
  type SecurityAuditPort,
  type SensitiveTextProtectorPort,
  type KnowledgeSpaceRepository,
} from '@rag/application';
import {
  AUTH_PORT,
  AuthenticationGuard,
  JwtAuthAdapter,
  MockAuthAdapter,
  ROLE_MAPPER,
  TrustedHeaderAuthAdapter,
  loadRoleMapper,
  type RoleMapper,
} from '@rag/auth';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import type { AuthPort, AuthorizationVersionPort } from '@rag/contracts';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { RagRunRedisModule, RedisPersistenceModule } from '@rag/persistence-redis';
import { AesGcmSensitiveTextProtector } from './aes-gcm-sensitive-text.protector';
import { ConversationsController, MessageFeedbackController } from './conversations.controller';
import { RunEventScheduler } from './run-event.scheduler';
import { RunsController, RunTicketStreamController } from './runs.controller';

/** M06 查询面模块。 */
@Module({
  imports: [PostgresPersistenceModule, RedisPersistenceModule, RagRunRedisModule],
  controllers: [
    ConversationsController,
    MessageFeedbackController,
    RunsController,
    RunTicketStreamController,
  ],
  providers: [
    {
      provide: ROLE_MAPPER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): RoleMapper => loadRoleMapper(config.auth.roleMappingFile),
    },
    {
      provide: AUTH_PORT,
      inject: [APP_CONFIG, ROLE_MAPPER, AUTHORIZATION_VERSION_PROVIDER],
      useFactory: (
        config: AppConfig,
        roleMapper: RoleMapper,
        versionProvider: AuthorizationVersionPort,
      ): AuthPort => createAuthPort(config, roleMapper, versionProvider),
    },
    {
      provide: AuthorizationService,
      inject: [KNOWLEDGE_SPACE_REPOSITORY, AUTHORIZATION_CACHE, SECURITY_AUDIT],
      useFactory: (
        repository: KnowledgeSpaceRepository,
        cache: AuthorizationCachePort,
        audit: SecurityAuditPort,
      ): AuthorizationService => new AuthorizationService(repository, cache, audit),
    },
    {
      provide: SENSITIVE_TEXT_PROTECTOR,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SensitiveTextProtectorPort =>
        new AesGcmSensitiveTextProtector(config.run),
    },
    {
      provide: RagRunService,
      inject: [
        RAG_RUN_REPOSITORY,
        AuthorizationService,
        SENSITIVE_TEXT_PROTECTOR,
        RAG_RUN_EVENT_STREAM,
        RAG_RUN_CANCELLATION,
        APP_CONFIG,
      ],
      useFactory: (
        repository: RagRunRepository,
        authorization: AuthorizationService,
        protector: SensitiveTextProtectorPort,
        stream: RagRunEventStreamPort,
        cancellation: RagRunCancellationPort,
        config: AppConfig,
      ): RagRunService =>
        new RagRunService(repository, authorization, protector, stream, cancellation, {
          flowVersion: config.run.flowVersion,
          policyVersion: config.run.policyVersion,
          promptProfileId: config.run.promptProfileId,
          validatorProfileId: config.run.validatorProfileId,
          embeddingProfileId: config.embedding.profileId,
          embeddingRevision: config.embedding.revision,
          rerankerProfileId: config.reranker.profileId,
          rerankerRevision: config.reranker.revision,
          llmProfileId: config.llm.profileId,
          llmRevision: config.llm.revision,
          deadlineSeconds: config.run.deadlineSeconds,
          eventRetentionSeconds: config.run.eventRetentionSeconds,
          contentRetentionDays: config.run.contentRetentionDays,
          streamTicketTtlSeconds: config.run.streamTicketTtlSeconds,
          shortWindowMessages: config.run.shortWindowMessages,
        }),
    },
    {
      provide: RagRunLifecycleService,
      inject: [RAG_RUN_REPOSITORY, SENSITIVE_TEXT_PROTECTOR, RAG_RUN_CANCELLATION, APP_CONFIG],
      useFactory: (
        repository: RagRunRepository,
        protector: SensitiveTextProtectorPort,
        cancellation: RagRunCancellationPort,
        config: AppConfig,
      ): RagRunLifecycleService =>
        new RagRunLifecycleService(repository, protector, cancellation, {
          contentRetentionDays: config.run.contentRetentionDays,
        }),
    },
    {
      provide: RagRunEventPublisherService,
      inject: [RAG_RUN_REPOSITORY, RAG_RUN_EVENT_STREAM, APP_CONFIG],
      useFactory: (
        repository: RagRunRepository,
        stream: RagRunEventStreamPort,
        config: AppConfig,
      ): RagRunEventPublisherService =>
        new RagRunEventPublisherService(repository, stream, {
          batchSize: config.run.eventPublishBatchSize,
          leaseSeconds: config.run.eventPublishLeaseSeconds,
          retentionSeconds: config.run.eventRetentionSeconds,
          maxLength: config.run.eventStreamMaxLength,
        }),
    },
    {
      provide: RagRunMaintenanceService,
      inject: [RAG_RUN_REPOSITORY],
      useFactory: (repository: RagRunRepository): RagRunMaintenanceService =>
        new RagRunMaintenanceService(repository),
    },
    AuthenticationGuard,
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
    RunEventScheduler,
  ],
  exports: [RagRunLifecycleService],
})
export class M06Module {}

function createAuthPort(
  config: AppConfig,
  roleMapper: RoleMapper,
  versionProvider: AuthorizationVersionPort,
): AuthPort {
  if (config.auth.mode === 'mock') {
    return new MockAuthAdapter(
      { appEnv: config.appEnv, ...config.auth.mock },
      roleMapper,
      versionProvider,
    );
  }
  if (config.auth.mode === 'trusted-header') {
    return new TrustedHeaderAuthAdapter(config.auth.trustedHeader, roleMapper, versionProvider);
  }
  const jwt = config.auth.jwt;
  if (!jwt.jwksUrl || !jwt.issuer || !jwt.audience) throw new Error('JWT 模式配置不完整');
  return new JwtAuthAdapter(
    { ...jwt, jwksUrl: jwt.jwksUrl, issuer: jwt.issuer, audience: jwt.audience },
    roleMapper,
    versionProvider,
  );
}
