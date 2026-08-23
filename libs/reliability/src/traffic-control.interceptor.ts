/**
 * 在线问答 Run 的全局、用户、角色、知识空间分布式流控拦截器。
 *
 * Guard 先建立可信 UserContext，本拦截器再提取创建 Run 请求中的空间 ID；所有 Redis 键
 * 均为 SHA-256，不包含用户名、角色原文或问题。任一维度拒绝时会释放此前已取得的租约，
 * 正常、异常和客户端取消也都会在 RxJS finalize 中释放，防止并发额度泄漏。
 *
 * @requirement OPS-007
 * @requirement OPS-009
 */
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import {
  ApplicationError,
  TRAFFIC_CONTROL,
  type TrafficControlPort,
  type TrafficControlRequest,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import type { UserContext } from '@rag/contracts';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';

type TrafficRequest = Request & {
  userContext?: UserContext;
  body: { requestedSpaceIds?: unknown };
};

/** 只拦截创建在线 Run；管理 API 和健康检查不消耗问答容量。 */
@Injectable()
export class TrafficControlInterceptor implements NestInterceptor {
  public constructor(
    @Inject(TRAFFIC_CONTROL) private readonly traffic: TrafficControlPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  public async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<TrafficRequest>();
    if (!isRunCreation(request)) return next.handle();
    if (!request.userContext) throw new ApplicationError('ACCESS_DENIED', 403, '缺少可信身份');

    const dimensions = buildDimensions(
      request.userContext,
      request.body?.requestedSpaceIds,
      this.config,
    );
    const leases: string[] = [];
    try {
      for (const dimension of dimensions) {
        const decision = await this.traffic.acquire(dimension);
        if (!decision.allowed) {
          throw new ApplicationError(
            'RATE_LIMITED',
            429,
            decision.reason === 'RATE'
              ? '问答请求过于频繁，请稍后重试'
              : '当前问答并发已满，请稍后重试',
            true,
          );
        }
        leases.push(decision.leaseId);
      }
    } catch (error) {
      await releaseAll(this.traffic, leases);
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        'TRAFFIC_CONTROL_UNAVAILABLE',
        503,
        '在线流控服务暂不可用，为保护知识库已拒绝本次新问答',
        true,
      );
    }

    return next.handle().pipe(finalize(() => void releaseAll(this.traffic, leases)));
  }
}

function isRunCreation(request: TrafficRequest): boolean {
  const path = request.originalUrl.split('?')[0] ?? '';
  return request.method === 'POST' && /\/api\/v1\/conversations\/[^/]+\/runs\/?$/.test(path);
}

function buildDimensions(
  user: UserContext,
  rawSpaceIds: unknown,
  config: AppConfig,
): TrafficControlRequest[] {
  const common = { rateWindowSeconds: 60, leaseSeconds: config.trafficControl.leaseSeconds };
  const result: TrafficControlRequest[] = [
    {
      ...common,
      bucket: 'global',
      key: digest('all'),
      rateLimit: config.trafficControl.globalRatePerMinute,
      concurrencyLimit: config.trafficControl.globalConcurrency,
    },
    {
      ...common,
      bucket: 'user',
      key: digest(user.userId),
      rateLimit: config.trafficControl.userRatePerMinute,
      concurrencyLimit: config.trafficControl.userConcurrency,
    },
  ];
  for (const role of [...user.roles].sort()) {
    result.push({
      ...common,
      bucket: 'role',
      key: digest(role),
      rateLimit: config.trafficControl.roleRatePerMinute,
      concurrencyLimit: config.trafficControl.roleConcurrency,
    });
  }
  if (Array.isArray(rawSpaceIds)) {
    const spaceIds = rawSpaceIds.filter((item): item is string => typeof item === 'string');
    for (const spaceId of [...new Set(spaceIds)]) {
      result.push({
        ...common,
        bucket: 'space',
        key: digest(spaceId),
        rateLimit: config.trafficControl.spaceRatePerMinute,
        concurrencyLimit: config.trafficControl.spaceConcurrency,
      });
    }
  }
  return result;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function releaseAll(traffic: TrafficControlPort, leaseIds: readonly string[]): Promise<void> {
  await Promise.allSettled(leaseIds.map((leaseId) => traffic.release(leaseId)));
}
