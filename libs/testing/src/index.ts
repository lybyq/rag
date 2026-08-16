/**
 * 跨模块测试工厂与契约断言边界。
 * 测试身份仍通过与真实认证 Adapter 相同的受限工厂创建，避免在测试里形成
 * “业务代码随便拼一个 userId/roles”这种错误示范。
 */
import { createTrustedUserContext } from '@rag/contracts-internal/user-context';
import type { SemanticRole, UserContext } from '@rag/contracts';

export const TESTING_BOUNDARY = 'testing' as const;

/** 创建默认授权版本为 1 的可信测试身份。 */
export function createTestUserContext(
  userId: string,
  roles: readonly SemanticRole[],
  authzVersion = 1,
): UserContext {
  return createTrustedUserContext({
    userId,
    roles,
    authzVersion,
    resolvedAt: '2026-08-16T08:00:00.000Z',
  });
}
