/**
 * 后台 Run 执行身份恢复器。
 *
 * HTTP 请求离开后，后台执行器不能伪造普通 UserContext，也不能使用服务账号扩大权限。本函数
 * 只接受 PostgreSQL 在创建 Run 事务中保存的角色，并与 Run 快照的角色摘要和授权版本核对后
 * 恢复可信身份。真正资源访问仍会按当前 ACL 再鉴权。
 *
 * @requirement ANS-003
 * @requirement ANS-011
 */
import type { SemanticRole, UserContext } from '@rag/contracts';
import { createTrustedUserContext } from '@rag/contracts-internal/user-context';
import { createHash } from 'node:crypto';
import { AuthenticationError } from './authentication.error';

/** 可由持久化 Adapter 提供的最小执行身份事实。 */
export interface PersistedRunIdentity {
  readonly userId: string;
  readonly roles: readonly SemanticRole[];
  readonly authzVersion: number;
  /** 执行当下的全局授权版本，用来隔离创建 Run 之后产生的 ACL 缓存。 */
  readonly currentAuthzVersion?: number;
  readonly expectedAuthzVersion: number;
  readonly expectedRolesSha256: string;
}

/** 校验 Run 创建时的身份摘要后恢复后台执行上下文。 */
export function rehydrateRunUserContext(identity: PersistedRunIdentity): UserContext {
  const actualRolesSha256 = createHash('sha256')
    .update([...identity.roles].sort().join('\u001f'))
    .digest('hex');
  if (
    identity.authzVersion !== identity.expectedAuthzVersion ||
    (identity.currentAuthzVersion ?? identity.authzVersion) < identity.expectedAuthzVersion ||
    actualRolesSha256 !== identity.expectedRolesSha256
  ) {
    throw new AuthenticationError('AUTH_INVALID', 'Run 执行身份快照无法验证');
  }
  return createTrustedUserContext({
    userId: identity.userId,
    roles: identity.roles,
    authzVersion: identity.currentAuthzVersion ?? identity.authzVersion,
    resolvedAt: new Date().toISOString(),
  });
}
