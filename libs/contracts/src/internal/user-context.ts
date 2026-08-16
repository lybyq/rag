import type { SemanticRole } from '../semantic-role';

/**
 * 可信用户上下文的内部构造入口。
 *
 * 这个文件故意不从 `@rag/contracts` 公共 barrel 导出构造函数。业务层只能看到
 * `UserContext` 类型，只有认证 Adapter 和测试 Adapter 可以通过受架构规则保护的
 * deep import 创建实例，从代码结构上收紧“客户端不能自报身份”的信任边界。
 *
 * @requirement AUTH-001
 */

/** 模块私有 Symbol 让普通对象无法在不绕过类型系统的情况下伪装成可信上下文。 */
const trustedUserContextBrand: unique symbol = Symbol('trusted-user-context');

/** 服务端完成认证和角色映射后，交给业务用例的最小身份快照。 */
export interface UserContext {
  /** 上游身份系统确认的稳定用户标识，不使用展示名或邮箱代替。 */
  readonly userId: string;
  /** 已映射为系统语义的角色；未知内网角色不会出现在这里。 */
  readonly roles: readonly SemanticRole[];
  /** 全局授权版本；ACL 改变后递增，用来隔离旧缓存。 */
  readonly authzVersion: number;
  /** 本次身份解析完成时间，便于审计身份快照的新鲜度。 */
  readonly resolvedAt: string;
  /** 不参与 JSON 序列化的编译期品牌。 */
  readonly [trustedUserContextBrand]: true;
}

/** 认证 Adapter 已验证但尚未品牌化的身份材料。 */
export interface VerifiedIdentity {
  readonly userId: string;
  readonly roles: readonly SemanticRole[];
  readonly authzVersion: number;
  readonly resolvedAt: string;
}

/**
 * 将已验证身份固化为不可变上下文。
 *
 * 注意：调用者必须先完成来源校验、签名校验和角色映射；这里不重复认证协议逻辑。
 * 架构门禁限制该函数只能被 `libs/auth` 与 `libs/testing` 直接引用。
 */
export function createTrustedUserContext(identity: VerifiedIdentity): UserContext {
  const context: UserContext = {
    userId: identity.userId,
    roles: Object.freeze([...new Set(identity.roles)].sort()),
    authzVersion: identity.authzVersion,
    resolvedAt: identity.resolvedAt,
    [trustedUserContextBrand]: true,
  };

  return Object.freeze(context);
}
