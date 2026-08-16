/**
 * 空间授权应用服务。
 * 它是 HTTP、异步任务、缓存命中和资源预览共同调用的唯一授权入口。
 *
 * @requirement AUTH-010
 * @requirement AUTH-011
 * @requirement AUTH-012
 * @requirement AUTH-013
 * @requirement AUTH-015
 */
import type { SpacePermission } from '@rag/contracts';
import { restrictRequestedSpaceIds } from '@rag/domain';
import { createHash } from 'node:crypto';
import { ApplicationError } from './application.error';
import type {
  AccessContext,
  AuthorizationCachePort,
  KnowledgeSpaceRepository,
  ProtectedResourceKind,
  SecurityAuditPort,
} from './ports';

const allPermissions: readonly SpacePermission[] = ['READ', 'WRITE', 'REVIEW', 'ADMIN'];

export class AuthorizationService {
  private readonly cacheTtlSeconds = 60;

  public constructor(
    private readonly repository: KnowledgeSpaceRepository,
    private readonly cache: AuthorizationCachePort,
    private readonly audit: SecurityAuditPort,
  ) {}

  /** 读取当前用户在一个空间的有效权限，缓存只保存服务端计算结果。 */
  public async getPermissions(
    context: AccessContext,
    spaceId: string,
  ): Promise<readonly SpacePermission[]> {
    if (context.user.roles.includes('SYSTEM_ADMIN')) return [...allPermissions];

    const cacheKey = this.buildCacheKey(context, spaceId);
    const cached = await this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const permissions = await this.repository.resolvePermissions(context, spaceId);
    await this.cache.set(cacheKey, permissions, this.cacheTtlSeconds);
    return permissions;
  }

  /** 要求一项空间权限；缺少时默认拒绝并审计。 */
  public async requirePermission(
    context: AccessContext,
    spaceId: string,
    requiredPermission: SpacePermission,
  ): Promise<void> {
    const permissions = await this.getPermissions(context, spaceId);
    if (permissions.includes(requiredPermission)) return;

    await this.audit.append(context, {
      action: `SPACE_${requiredPermission}`,
      resourceType: 'KNOWLEDGE_SPACE',
      resourceId: spaceId,
      result: 'DENIED',
      reason: 'effective permission missing',
    });
    throw new ApplicationError('ACCESS_DENIED', 403, '无权访问该知识空间');
  }

  /**
   * 先反查资源所属空间，再执行当前权限检查。
   * 找不到资源与没有权限统一返回拒绝，避免通过响应差异枚举资源 ID。
   */
  public async requireResourcePermission(
    context: AccessContext,
    kind: ProtectedResourceKind,
    resourceId: string,
    requiredPermission: SpacePermission,
  ): Promise<string> {
    const spaceId = await this.repository.resolveResourceSpaceId(context, kind, resourceId);
    if (!spaceId) {
      await this.audit.append(context, {
        action: `${kind}_${requiredPermission}`,
        resourceType: kind,
        resourceId,
        result: 'DENIED',
        reason: 'resource is missing or invisible',
      });
      throw new ApplicationError('ACCESS_DENIED', 403, '无权访问该资源');
    }

    await this.requirePermission(context, spaceId, requiredPermission);
    return spaceId;
  }

  /** 把客户端请求空间与服务端可访问空间取交集。 */
  public async restrictRequestedSpaces(
    context: AccessContext,
    requestedSpaceIds: readonly string[] | undefined,
  ): Promise<readonly string[]> {
    const allowedSpaceIds = context.user.roles.includes('SYSTEM_ADMIN')
      ? await this.repository.listAccessibleSpaceIds(context)
      : await this.repository.listAccessibleSpaceIds(context);
    return restrictRequestedSpaceIds(allowedSpaceIds, requestedSpaceIds);
  }

  /** ACL 改变后主动清空本进程缓存；新 authzVersion 还提供第二道隔离。 */
  public async invalidate(): Promise<void> {
    await this.cache.invalidateAll();
  }

  /** Key 不暴露角色明文，但包含排序后角色集合的 SHA-256 摘要。 */
  private buildCacheKey(context: AccessContext, spaceId: string): string {
    const rolesHash = createHash('sha256')
      .update([...context.user.roles].sort().join('\u001f'), 'utf8')
      .digest('hex');
    return `authz:v${context.user.authzVersion}:u:${encodeURIComponent(context.user.userId)}:r:${rolesHash}:s:${spaceId}`;
  }
}
