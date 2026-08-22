/**
 * 将已校验配置作为全局只读依赖注入对象提供给 NestJS。
 * 业务代码只能注入 AppConfig，不能在任意位置直接读取 process.env。
 *
 * @requirement BASE-010
 */
import { Global, Module } from '@nestjs/common';
import { loadAppConfig, type AppConfig } from './app-config';
import { loadProfileEnvironment } from './provider-profile';

/** NestJS 注入 AppConfig 时使用的唯一 Token。 */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** 为所有应用提供同一配置加载和失败策略。 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadAppConfig(loadProfileEnvironment(process.env)),
    },
  ],
  exports: [APP_CONFIG],
})
export class RuntimeConfigModule {}
