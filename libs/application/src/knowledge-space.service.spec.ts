import type { KnowledgeSpace, SpacePermission } from '@rag/contracts';
import { createTestUserContext } from '@rag/testing';
import { AuthorizationService } from './authorization.service';
import { KnowledgeSpaceService } from './knowledge-space.service';
import type {
  AccessContext,
  AuthorizationCachePort,
  KnowledgeSpaceRepository,
  SecurityAuditPort,
} from './ports';

const space: KnowledgeSpace = {
  id: '20000000-0000-4000-8000-000000000001',
  code: 'hr-policy',
  name: '人力制度库',
  description: null,
  ownerUserId: 'editor-1',
  status: 'ACTIVE',
  version: 1,
  policyVersion: 1,
  documentCount: 0,
  createdAt: '2026-08-16T08:00:00.000Z',
  updatedAt: '2026-08-16T08:00:00.000Z',
  effectivePermissions: ['READ', 'WRITE', 'REVIEW', 'ADMIN'],
};

function context(
  userId: string,
  roles: Parameters<typeof createTestUserContext>[1],
): AccessContext {
  return { user: createTestUserContext(userId, roles), requestId: 'm01-space-test' };
}

function createServices(
  permissions: readonly SpacePermission[] = ['READ', 'WRITE', 'REVIEW', 'ADMIN'],
): {
  repository: jest.Mocked<KnowledgeSpaceRepository>;
  cache: jest.Mocked<AuthorizationCachePort>;
  audit: jest.Mocked<SecurityAuditPort>;
  service: KnowledgeSpaceService;
} {
  const repository = {
    create: jest.fn(async () => space),
    resolvePermissions: jest.fn(async () => permissions),
    upsertGrant: jest.fn(async () => ({
      id: '10000000-0000-4000-8000-000000000001',
      spaceId: space.id,
      subjectType: 'ROLE' as const,
      subjectId: 'KNOWLEDGE_READER',
      permissions: ['READ'] as const,
      createdBy: 'editor-1',
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
    })),
  } as unknown as jest.Mocked<KnowledgeSpaceRepository>;
  const cache = {
    get: jest.fn(async () => undefined),
    set: jest.fn(async () => undefined),
    invalidateAll: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<AuthorizationCachePort>;
  const audit = {
    append: jest.fn(async () => undefined),
    appendAuthenticationDenied: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<SecurityAuditPort>;
  const authorization = new AuthorizationService(repository, cache, audit);
  return {
    repository,
    cache,
    audit,
    service: new KnowledgeSpaceService(repository, authorization, audit),
  };
}

describe('[AUTH-009][AUTH-015] KnowledgeSpaceService', () => {
  it('知识编辑者创建空间时只能默认把自己设为 owner', async () => {
    const { service, repository, cache } = createServices();
    const access = context('editor-1', ['KNOWLEDGE_EDITOR']);

    await service.create(access, { code: 'hr-policy', name: '人力制度库', description: null });

    expect(repository.create).toHaveBeenCalledWith(
      access,
      expect.objectContaining({ ownerUserId: 'editor-1' }),
    );
    expect(cache.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it('普通阅读者创建空间会默认拒绝并审计', async () => {
    const { service, repository, audit } = createServices();
    const access = context('reader-1', ['KNOWLEDGE_READER']);

    await expect(
      service.create(access, { code: 'secret', name: '越权空间', description: null }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(repository.create).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      access,
      expect.objectContaining({ action: 'SPACE_CREATE', result: 'DENIED' }),
    );
  });

  it('只有 SYSTEM_ADMIN 可以替别人指定 owner', async () => {
    const { service } = createServices();
    await expect(
      service.create(context('editor-1', ['KNOWLEDGE_EDITOR']), {
        code: 'finance',
        name: '财务知识库',
        description: null,
        ownerUserId: 'finance-owner',
      }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    await expect(
      service.create(context('system-1', ['SYSTEM_ADMIN']), {
        code: 'finance',
        name: '财务知识库',
        description: null,
        ownerUserId: 'finance-owner',
      }),
    ).resolves.toEqual(space);
  });

  it('授权写入后主动失效缓存并记录主体，不记录认证秘密', async () => {
    const { service, cache, audit } = createServices();
    const access = context('editor-1', ['KNOWLEDGE_ADMIN']);
    await service.upsertGrant(access, space.id, {
      subjectType: 'ROLE',
      subjectId: 'KNOWLEDGE_READER',
      permissions: ['READ'],
      reason: '开放制度阅读',
    });

    expect(cache.invalidateAll).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(
      access,
      expect.objectContaining({
        action: 'SPACE_GRANT_UPSERT',
        metadata: { subjectType: 'ROLE', subjectId: 'KNOWLEDGE_READER' },
      }),
    );
  });
});
