/** M01 在平台 API 中的 Composition Root。 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  AUTHORIZATION_CACHE,
  AUTHORIZATION_VERSION_PROVIDER,
  AuthorizationService,
  KNOWLEDGE_SPACE_REPOSITORY,
  KnowledgeSpaceService,
  SECURITY_AUDIT,
  type AuthorizationCachePort,
  type KnowledgeSpaceRepository,
  type SecurityAuditPort,
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
import { RedisPersistenceModule } from '@rag/persistence-redis';
import { IdentityController } from './identity.controller';
import { KnowledgeSpacesController } from './knowledge-spaces.controller';

@Module({
  imports: [PostgresPersistenceModule, RedisPersistenceModule],
  controllers: [IdentityController, KnowledgeSpacesController],
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
      ): AuthPort => {
        if (config.auth.mode === 'mock') {
          return new MockAuthAdapter(
            {
              appEnv: config.appEnv,
              ...config.auth.mock,
            },
            roleMapper,
            versionProvider,
          );
        }
        if (config.auth.mode === 'trusted-header') {
          return new TrustedHeaderAuthAdapter(
            config.auth.trustedHeader,
            roleMapper,
            versionProvider,
          );
        }
        const jwtConfig = config.auth.jwt;
        if (!jwtConfig.jwksUrl || !jwtConfig.issuer || !jwtConfig.audience) {
          throw new Error('JWT 模式配置不完整');
        }
        return new JwtAuthAdapter(
          {
            ...jwtConfig,
            jwksUrl: jwtConfig.jwksUrl,
            issuer: jwtConfig.issuer,
            audience: jwtConfig.audience,
          },
          roleMapper,
          versionProvider,
        );
      },
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
      provide: KnowledgeSpaceService,
      inject: [KNOWLEDGE_SPACE_REPOSITORY, AuthorizationService, SECURITY_AUDIT],
      useFactory: (
        repository: KnowledgeSpaceRepository,
        authorization: AuthorizationService,
        audit: SecurityAuditPort,
      ): KnowledgeSpaceService => new KnowledgeSpaceService(repository, authorization, audit),
    },
    AuthenticationGuard,
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
  ],
})
export class M01Module {}
