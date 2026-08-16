/**
 * 应用层公共出口。
 * 应用层负责组织用例，并通过接口依赖外部能力，不直接依赖具体 Adapter。
 *
 * @requirement BASE-004
 */
export const APPLICATION_BOUNDARY = 'application' as const;
