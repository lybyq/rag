/**
 * 身份、系统语义角色与认证端口契约。
 * 本文件没有 NestJS/Express 依赖，因此三种认证 Adapter 可以共享同一业务边界。
 *
 * @requirement AUTH-001
 * @requirement AUTH-002
 * @requirement AUTH-006
 */
import { z } from 'zod';
import type { UserContext } from './internal/user-context';
export { SemanticRoleSchema, type SemanticRole } from './semantic-role';
import { SemanticRoleSchema } from './semantic-role';

/** 对外序列化的可信身份 Schema；品牌字段只存在于 TypeScript 内部。 */
export const UserContextSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  roles: z.array(SemanticRoleSchema),
  authzVersion: z.number().int().nonnegative(),
  resolvedAt: z.iso.datetime({ offset: true }),
});

/** 重新导出只读身份类型，公共入口不会导出它的构造函数。 */
export type { UserContext } from './internal/user-context';

/** 与具体 HTTP 框架解耦的认证请求快照。 */
export interface AuthenticationRequest {
  /** Header 名必须已经转为小写；重复 Header 保留为数组供 Adapter 拒绝歧义。 */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** 与服务直接建立 TCP 连接的地址，而不是可伪造的 X-Forwarded-For。 */
  readonly remoteAddress?: string;
}

/** 所有认证传输方式共同实现的入口。 */
export interface AuthPort {
  authenticate(request: AuthenticationRequest): Promise<UserContext>;
}

/** 为身份快照提供当前全局授权版本。 */
export interface AuthorizationVersionPort {
  getCurrentVersion(): Promise<number>;
}

/** Nest 等框架用同一个元数据键声明无需业务认证的基础设施路由。 */
export const PUBLIC_ROUTE_METADATA = 'rag:public-route';
