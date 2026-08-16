/**
 * 维护一次请求内共享的诊断上下文。
 * AsyncLocalStorage 会沿 Promise/await 链传播数据，业务代码不需要层层传递 requestId。
 *
 * @requirement BASE-007
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/** 单次 HTTP 请求可供日志、响应和指标读取的关联标识。 */
export interface RequestContextData {
  requestId: string;
  traceId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContextData>();
const safeRequestIdPattern = /^[A-Za-z0-9._:-]{8,128}$/;

/** 信任格式安全的上游 ID，否则生成新的 UUID，供 Pino 与业务上下文复用。 */
export function normalizeRequestId(incomingRequestId: string | undefined): string {
  return incomingRequestId && safeRequestIdPattern.test(incomingRequestId)
    ? incomingRequestId
    : randomUUID();
}

/** 读取当前请求上下文；非 HTTP 后台任务可能没有上下文。 */
@Injectable()
export class RequestContextService {
  public get(): RequestContextData | undefined {
    return requestContextStorage.getStore();
  }

  /** 获取当前 Request ID；在极少数非请求场景生成一个新值以保证错误可追踪。 */
  public getRequestId(): string {
    return this.get()?.requestId ?? randomUUID();
  }
}

/**
 * 在业务控制器执行前建立请求上下文，并将关联标识写回响应头。
 * 上游传入的 Request ID 只有符合白名单格式才会被信任，防止日志注入。
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  public use(request: Request, response: Response, next: NextFunction): void {
    const requestId = normalizeRequestId(request.header('x-request-id'));
    const activeTraceId = trace.getActiveSpan()?.spanContext().traceId;
    const context: RequestContextData = {
      requestId,
      ...(activeTraceId ? { traceId: activeTraceId } : {}),
    };

    response.setHeader('x-request-id', requestId);
    if (activeTraceId) response.setHeader('x-trace-id', activeTraceId);
    requestContextStorage.run(context, next);
  }
}
