import type { SpacePermission } from '@rag/contracts';
import { createTestUserContext } from '@rag/testing';
import { AuthorizationService } from './authorization.service';
import type {
  AccessContext,
  AuthorizationCachePort,
  KnowledgeSpaceRepository,
  SecurityAuditPort,
} from './ports';

function createAccessContext(
  userId: string,
  roles: Parameters<typeof createTestUserContext>[1],
  authzVersion = 1,
): AccessContext {
  return {
    user: createTestUserContext(userId, roles, authzVersion),
    requestId: 'm01-authorization-test',
  };
}

describe('[AUTH-010][AUTH-012] AuthorizationService', () => {
  it('缓存 Key 同时隔离用户、角色集合 Hash、授权版本和空间', async () => {
    const cacheValues = new Map<string, readonly SpacePermission[]>();
    const cache: AuthorizationCachePort = {
      get: async (key) => cacheValues.get(key),
      set: async (key, value) => void cacheValues.set(key, value),
      invalidateAll: async () => void cacheValues.clear(),
    };
    const resolvePermissions = jest.fn(async () => ['READ'] as const);
    const repository = {
      resolvePermissions,
    } as unknown as KnowledgeSpaceRepository;
    const audit = {
      append: jest.fn(async () => undefined),
      appendAuthenticationDenied: jest.fn(async () => undefined),
    } as SecurityAuditPort;
    const service = new AuthorizationService(repository, cache, audit);

    await service.getPermissions(createAccessContext('alice', ['KNOWLEDGE_READER'], 5), 'space-1');
    await service.getPermissions(createAccessContext('alice', ['KNOWLEDGE_READER'], 5), 'space-1');
    await service.getPermissions(createAccessContext('alice', ['KNOWLEDGE_READER'], 6), 'space-1');

    expect(resolvePermissions).toHaveBeenCalledTimes(2);
    const keys = [...cacheValues.keys()];
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain('alice');
    expect(keys[0]).toContain('v5');
    expect(keys[0]).toContain('space-1');
    expect(keys[0]).not.toContain('KNOWLEDGE_READER');
  });

  it('无权访问默认拒绝并写审计日志', async () => {
    const repository = {
      resolvePermissions: jest.fn(async () => []),
    } as unknown as KnowledgeSpaceRepository;
    const cache = {
      get: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
      invalidateAll: jest.fn(async () => undefined),
    } as AuthorizationCachePort;
    const audit = {
      append: jest.fn(async () => undefined),
      appendAuthenticationDenied: jest.fn(async () => undefined),
    } as SecurityAuditPort;
    const service = new AuthorizationService(repository, cache, audit);
    const context = createAccessContext('reader', ['KNOWLEDGE_READER']);

    await expect(service.requirePermission(context, 'space-secret', 'READ')).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect(audit.append).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ result: 'DENIED', resourceId: 'space-secret' }),
    );
  });
});

describe('[AUTH-011][AUTH-013] scope restriction and resource re-authorization', () => {
  it('requestedSpaceIds 只能缩小 Repository 返回的服务端范围', async () => {
    const repository = {
      listAccessibleSpaceIds: jest.fn(async () => ['space-a', 'space-b']),
    } as unknown as KnowledgeSpaceRepository;
    const service = new AuthorizationService(
      repository,
      {
        get: async () => undefined,
        set: async () => undefined,
        invalidateAll: async () => undefined,
      },
      { append: async () => undefined, appendAuthenticationDenied: async () => undefined },
    );

    await expect(
      service.restrictRequestedSpaces(createAccessContext('reader', ['KNOWLEDGE_READER']), [
        'space-b',
        'space-forged',
      ]),
    ).resolves.toEqual(['space-b']);
  });

  it.each(['DOCUMENT', 'CITATION', 'HISTORY_MESSAGE', 'RETRIEVAL_CANDIDATE', 'EXPORT'] as const)(
    '%s 会反查所属空间并执行当前权限检查',
    async (kind) => {
      const repository = {
        resolveResourceSpaceId: jest.fn(async () => 'space-1'),
        resolvePermissions: jest.fn(async () => ['READ']),
      } as unknown as KnowledgeSpaceRepository;
      const service = new AuthorizationService(
        repository,
        {
          get: async () => undefined,
          set: async () => undefined,
          invalidateAll: async () => undefined,
        },
        { append: async () => undefined, appendAuthenticationDenied: async () => undefined },
      );
      const context = createAccessContext('reader', ['KNOWLEDGE_READER']);

      await expect(
        service.requireResourcePermission(context, kind, 'resource-1', 'READ'),
      ).resolves.toBe('space-1');
      expect(repository.resolveResourceSpaceId).toHaveBeenCalledWith(context, kind, 'resource-1');
    },
  );
});
