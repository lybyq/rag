/**
 * Provider 双环境 Profile 的受控启动加载器。
 * 它只允许枚举映射到仓库根目录下固定的 `.env.<profile>` 文件，并保证容器/CI 注入的环境变量优先。
 * 本文件不校验具体 Provider 参数，也不在运行中监听文件变化；完整校验由 `loadAppConfig` 完成。
 *
 * @requirement CFG-001
 * @requirement CFG-002
 * @requirement CFG-003
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ProviderProfileSchema, type ProviderProfile } from '@rag/contracts';

export { ProviderProfileSchema };
export type { ProviderProfile };

/** Profile 到真实环境文件的白名单映射；`.example` 永远不会被运行时读取。 */
export const PROVIDER_PROFILE_FILES: Readonly<Record<ProviderProfile, string>> = Object.freeze({
  test: '.env.test',
  'external-dev': '.env.external-dev',
  'external-ci': '.env.external-ci',
  'intranet-staging': '.env.intranet-staging',
  'intranet-production': '.env.intranet-production',
});

/** 测试和不同启动目录可显式传入仓库根；生产默认使用进程工作目录。 */
export interface ProfileEnvironmentOptions {
  readonly rootDirectory?: string;
}

/**
 * 加载当前 Profile 的真实环境文件，并让部署平台环境变量覆盖文件值。
 *
 * 合并顺序不能反转：Secret Manager/Kubernetes 注入的新密钥必须覆盖磁盘中可能过期的配置。
 * Profile 文件不存在时继续使用宿主环境与代码安全默认值，最终是否足够由 AppConfig fail-closed 校验决定。
 */
export function loadProfileEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
  options: ProfileEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const profile = ProviderProfileSchema.parse(hostEnvironment.PROVIDER_PROFILE ?? 'external-dev');
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const profilePath = resolve(rootDirectory, PROVIDER_PROFILE_FILES[profile]);
  const fileEnvironment = existsSync(profilePath)
    ? parseEnv(readFileSync(profilePath, 'utf8'))
    : {};

  return {
    ...fileEnvironment,
    ...hostEnvironment,
    PROVIDER_PROFILE: profile,
  };
}
