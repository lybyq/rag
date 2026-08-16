/** 认证 Adapter 共用的可信上下文收口，避免三套实现产生不同字段语义。 */
import type { AuthorizationVersionPort, UserContext } from '@rag/contracts';
import { createTrustedUserContext } from '@rag/contracts-internal/user-context';
import { AuthenticationError } from './authentication.error';
import type { RoleMapper } from './role-mapper';

const safeUserIdPattern = /^\S{1,128}$/u;

/** 控制字符会污染日志和审计字段，必须在进入可信上下文前拒绝。 */
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

/** 完成用户标识校验、角色映射和授权版本绑定。 */
export async function createAuthenticatedContext(
  userId: string,
  sourceRoles: readonly string[],
  roleMapper: RoleMapper,
  versionProvider: AuthorizationVersionPort,
  now: () => number = Date.now,
): Promise<UserContext> {
  const normalizedUserId = userId.trim();
  if (!safeUserIdPattern.test(normalizedUserId) || containsControlCharacter(normalizedUserId)) {
    throw new AuthenticationError('AUTH_INVALID', '认证信息无效');
  }

  const authzVersion = await versionProvider.getCurrentVersion();
  if (!Number.isSafeInteger(authzVersion) || authzVersion < 0) {
    throw new AuthenticationError('AUTH_INVALID', '认证信息无法验证');
  }

  return createTrustedUserContext({
    userId: normalizedUserId,
    roles: roleMapper.map(sourceRoles),
    authzVersion,
    resolvedAt: new Date(now()).toISOString(),
  });
}
