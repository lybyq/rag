/**
 * 领域层公共出口。
 * M00 只建立边界；实体、值对象和领域规则将在对应业务模块中逐步加入。
 * 此层不得依赖 NestJS、数据库 SDK 或任何基础设施实现。
 *
 * @requirement BASE-004
 */
export const DOMAIN_BOUNDARY = 'domain' as const;
