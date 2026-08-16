/**
 * 组合结构化日志、请求上下文、错误边界与 Prometheus 指标。
 * 日志配置在入口处统一安装，业务模块只注入 Logger，不感知 Pino 传输细节。
 *
 * @requirement BASE-007
 * @requirement BASE-008
 */
import {
  Global,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { trace } from '@opentelemetry/api';
import { APP_CONFIG, type AppConfig, RuntimeConfigModule } from '@rag/config';
import { LoggerModule } from 'nestjs-pino';
import { ApiExceptionFilter } from './api-exception.filter';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';
import {
  normalizeRequestId,
  RequestContextMiddleware,
  RequestContextService,
} from './request-context';

/** 需要从任何日志对象中递归移除的敏感字段路径。 */
const redactionPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-api-key',
  'authorization',
  'password',
  'secret',
  'token',
  '*.password',
  '*.secret',
  '*.token',
];

@Global()
@Module({
  imports: [
    RuntimeConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          genReqId: (request, response) => {
            const incoming = request.headers['x-request-id'];
            const requestId = normalizeRequestId(
              typeof incoming === 'string' ? incoming : undefined,
            );
            // 写回请求头后，后执行的 AsyncLocalStorage 中间件会读取同一个 ID。
            request.headers['x-request-id'] = requestId;
            response.setHeader('x-request-id', requestId);
            return requestId;
          },
          customProps: (request) => {
            const requestId = request.headers['x-request-id'];
            const traceId = trace.getActiveSpan()?.spanContext().traceId;
            return {
              requestId: typeof requestId === 'string' ? requestId : undefined,
              ...(traceId ? { traceId } : {}),
            };
          },
          redact: { paths: redactionPaths, censor: '[REDACTED]' },
          quietReqLogger: true,
          autoLogging: {
            ignore: (request) => request.url === '/api/v1/health/live',
          },
        },
      }),
    }),
  ],
  controllers: [MetricsController],
  providers: [
    RequestContextService,
    RequestContextMiddleware,
    MetricsService,
    MetricsInterceptor,
    ApiExceptionFilter,
    { provide: APP_FILTER, useExisting: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useExisting: MetricsInterceptor },
  ],
  exports: [RequestContextService, MetricsService, LoggerModule],
})
export class ObservabilityModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
