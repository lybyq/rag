/** 真实 PostgreSQL 上验证空间、ACL、策略版本和授权版本的事务闭环。 */
import { type AccessContext, type SecurityAuditEvent } from '@rag/application';
import { loadAppConfig } from '@rag/config';
import {
  PostgresAuthorizationVersionProvider,
  PostgresKnowledgeSpaceRepository,
  PostgresSecurityAuditAdapter,
} from '@rag/persistence-pg';
import { RedisAuthorizationCacheAdapter } from '@rag/persistence-redis';
import { createTestUserContext } from '@rag/testing';
import { Pool } from 'pg';

const describeWithInfra = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeWithInfra('[AUTH-007][AUTH-012][AUTH-015] M01 PostgreSQL transaction', () => {
  const config = loadAppConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 3 });
  const repository = new PostgresKnowledgeSpaceRepository(pool);
  const versionProvider = new PostgresAuthorizationVersionProvider(pool);
  const audit = new PostgresSecurityAuditAdapter(pool);
  const authorizationCache = new RedisAuthorizationCacheAdapter(config);
  const suffix = Date.now().toString(36);
  let createdSpaceId = '';

  const adminContext: AccessContext = {
    user: createTestUserContext(`owner-${suffix}`, ['KNOWLEDGE_EDITOR']),
    requestId: `m01-integration-${suffix}`,
  };

  afterAll(async () => {
    if (createdSpaceId) {
      await pool.query('DELETE FROM audit_logs WHERE request_id = $1', [adminContext.requestId]);
      await pool.query('DELETE FROM knowledge_space_policies WHERE space_id = $1', [
        createdSpaceId,
      ]);
      await pool.query('DELETE FROM resource_acl WHERE resource_id = $1', [createdSpaceId]);
      await pool.query('DELETE FROM protected_resource_spaces WHERE space_id = $1', [
        createdSpaceId,
      ]);
      await pool.query('DELETE FROM knowledge_spaces WHERE id = $1', [createdSpaceId]);
    }
    authorizationCache.onModuleDestroy();
    await pool.end();
  });

  it('创建 owner ACL，授权/撤权生成版本并递增全局 authzVersion', async () => {
    const beforeVersion = await versionProvider.getCurrentVersion();
    const space = await repository.create(adminContext, {
      code: `m01-it-${suffix}`,
      name: 'M01 集成测试空间',
      description: null,
      ownerUserId: adminContext.user.userId,
    });
    createdSpaceId = space.id;
    await expect(repository.resolvePermissions(adminContext, space.id)).resolves.toEqual([
      'READ',
      'WRITE',
      'REVIEW',
      'ADMIN',
    ]);

    const grant = await repository.upsertGrant(adminContext, space.id, {
      subjectType: 'ROLE',
      subjectId: 'KNOWLEDGE_READER',
      permissions: ['READ'],
      reason: 'integration grant',
    });
    const readerContext: AccessContext = {
      user: createTestUserContext(`reader-${suffix}`, ['KNOWLEDGE_READER']),
      requestId: adminContext.requestId,
    };
    await expect(repository.resolvePermissions(readerContext, space.id)).resolves.toEqual(['READ']);
    await expect(repository.listPolicyVersions(adminContext, space.id)).resolves.toHaveLength(2);

    await repository.revokeGrant(adminContext, space.id, grant.id, 'integration revoke');
    await expect(repository.resolvePermissions(readerContext, space.id)).resolves.toEqual([]);
    await expect(versionProvider.getCurrentVersion()).resolves.toBeGreaterThan(beforeVersion);
  });

  it('审计 Adapter 丢弃敏感 metadata 字段', async () => {
    const event: SecurityAuditEvent = {
      action: 'INTEGRATION_AUDIT',
      resourceType: 'KNOWLEDGE_SPACE',
      resourceId: createdSpaceId,
      result: 'SUCCESS',
      metadata: { subjectId: 'reader', token: 'must-not-be-stored' },
    };
    await audit.append(adminContext, event);
    const result = await pool.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM audit_logs WHERE request_id = $1 AND action = $2',
      [adminContext.requestId, event.action],
    );
    expect(result.rows[0]?.metadata).toEqual({ subjectId: 'reader' });
  });

  it('Redis generation 主动失效旧授权缓存', async () => {
    const cacheKey = `integration:${suffix}`;
    await authorizationCache.set(cacheKey, ['READ'], 60);
    await expect(authorizationCache.get(cacheKey)).resolves.toEqual(['READ']);

    await authorizationCache.invalidateAll();
    await expect(authorizationCache.get(cacheKey)).resolves.toBeUndefined();
  });
});
