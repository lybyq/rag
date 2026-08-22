/**
 * 跨进程共享的 Provider 部署画像契约。
 *
 * 它只定义可序列化的稳定枚举，供配置加载器、Application 命令、Run 事实和 OpenAPI 复用。
 * 本文件不读取环境变量、不决定 Adapter，也不包含 Endpoint 或 Secret。
 *
 * @requirement CFG-001
 * @requirement CFG-007
 * @requirement CFG-012
 */
import { z } from 'zod';

/** 系统允许启动和写入历史 Run 的五种受控 Provider Profile。 */
export const ProviderProfileSchema = z.enum([
  'test',
  'external-dev',
  'external-ci',
  'intranet-staging',
  'intranet-production',
]);

/** Provider Profile 的稳定联合类型。 */
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
