/** 为全部 HTTP 请求记录低基数耗时指标。 */
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { type Observable, finalize } from 'rxjs';
import { MetricsService } from './metrics.service';

/** 使用 RxJS finalize 保证成功和异常请求都会结束计时器。 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  public constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = process.hrtime.bigint();

    return next.handle().pipe(
      finalize(() => {
        const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        const route = request.route?.path ? String(request.route.path) : 'unmatched';
        this.metrics.httpDurationSeconds.observe(
          { method: request.method, route, status_code: String(response.statusCode) },
          durationSeconds,
        );
      }),
    );
  }
}
