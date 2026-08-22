/** 核心 API、Worker 与独立 Provider Service 共享的安全启动和优雅关闭流程。 */
import { type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { Logger } from 'nestjs-pino';
import { stopTracing } from './tracing';

export interface BootstrapHttpOptions {
  /** HTTP 服务读取 httpPort；worker 的探针监听器读取 probePort。 */
  portKind: 'http' | 'probe';
  /** 独立 Provider Service 可使用 `v1`；平台 API 默认保持 `api/v1`。 */
  readonly globalPrefix?: string;
}

/**
 * 创建带统一日志、CORS、版本前缀和退出钩子的 Nest HTTP 进程。
 * worker 仍暴露只用于运维的健康/指标端口，真正任务消费者将在后续模块注册。
 */
export async function bootstrapHttpApplication(
  rootModule: Type<unknown>,
  options: BootstrapHttpOptions,
): Promise<void> {
  const application = await NestFactory.create(rootModule, { bufferLogs: true });
  const config = application.get<AppConfig>(APP_CONFIG);
  application.useLogger(application.get(Logger));
  application.setGlobalPrefix(options.globalPrefix ?? 'api/v1');
  application.enableCors({
    origin: [...config.corsAllowedOrigins],
    credentials: true,
  });
  application.enableShutdownHooks();

  const port = options.portKind === 'http' ? config.httpPort : config.probePort;
  await application.listen(port, '0.0.0.0');

  const shutdownTracing = (): void => {
    void stopTracing();
  };
  process.once('SIGTERM', shutdownTracing);
  process.once('SIGINT', shutdownTracing);
}
