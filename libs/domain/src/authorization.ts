/**
 * 不依赖框架和数据库的授权领域规则。
 * 把规则集中在这里的目的，是让 HTTP、Worker、缓存命中和导出任务得到完全相同的结论。
 *
 * @requirement AUTH-008
 * @requirement AUTH-011
 */
import type { SemanticRole, SpaceGrant, SpacePermission, UserContext } from '@rag/contracts';

/** 权限按从低到高的固定顺序输出，避免缓存和审计出现等价但不同序列。 */
const permissionOrder: readonly SpacePermission[] = ['READ', 'WRITE', 'REVIEW', 'ADMIN'];

/** 每项原子权限所蕴含的工作权限。WRITE 和 REVIEW 互不蕴含。 */
const impliedPermissions: Readonly<Record<SpacePermission, readonly SpacePermission[]>> = {
  READ: ['READ'],
  WRITE: ['READ', 'WRITE'],
  REVIEW: ['READ', 'REVIEW'],
  ADMIN: ['READ', 'WRITE', 'REVIEW', 'ADMIN'],
};

/**
 * 展开权限蕴含关系并按固定顺序去重。
 * 例如编辑必须能读取原文，但审核者不一定可以修改原文。
 */
export function expandPermissions(
  permissions: readonly SpacePermission[],
): readonly SpacePermission[] {
  const expanded = new Set<SpacePermission>();
  for (const permission of permissions) {
    for (const implied of impliedPermissions[permission]) expanded.add(implied);
  }
  return permissionOrder.filter((permission) => expanded.has(permission));
}

/** 判断一条 ACL 的主体是否与已认证身份匹配。 */
export function matchesAclSubject(user: UserContext, grant: SpaceGrant): boolean {
  if (grant.subjectType === 'USER') return grant.subjectId === user.userId;
  return user.roles.some((role) => role === grant.subjectId);
}

/** 聚合用户和角色 ACL，并应用权限蕴含关系。 */
export function resolveEffectivePermissions(
  user: UserContext,
  grants: readonly SpaceGrant[],
): readonly SpacePermission[] {
  if (user.roles.includes('SYSTEM_ADMIN')) return [...permissionOrder];
  const directPermissions = grants
    .filter((grant) => matchesAclSubject(user, grant))
    .flatMap((grant) => grant.permissions);
  return expandPermissions(directPermissions);
}

/** 根据 PRD：编辑者、知识管理员和系统管理员可以创建空间。 */
export function isAllowedToCreateKnowledgeSpace(roles: readonly SemanticRole[]): boolean {
  return roles.some((role) =>
    ['KNOWLEDGE_EDITOR', 'KNOWLEDGE_ADMIN', 'SYSTEM_ADMIN'].includes(role),
  );
}

/**
 * 将客户端请求范围限制在服务端可访问范围内。
 * `undefined` 表示客户端不再缩小；空数组明确表示不选择任何空间。
 */
export function restrictRequestedSpaceIds(
  allowedSpaceIds: readonly string[],
  requestedSpaceIds: readonly string[] | undefined,
): readonly string[] {
  if (requestedSpaceIds === undefined) return [...allowedSpaceIds];

  const allowed = new Set(allowedSpaceIds);
  return [...new Set(requestedSpaceIds)].filter((spaceId) => allowed.has(spaceId));
}
