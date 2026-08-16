/**
 * NestJS 全局认证 Guard。
 * 它只建立可信 UserContext，不在这里塞入知识空间业务授权，保持认证/授权职责分离。
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SECURITY_AUDIT, type SecurityAuditPort } from '@rag/application';
import { PUBLIC_ROUTE_METADATA, type AuthPort, type UserContext } from '@rag/contracts';
import { RequestContextService } from '@rag/observability';
import type { Request } from 'express';
import { AuthenticationError } from './authentication.error';
import { AUTH_PORT } from './auth.tokens';

/** 带服务端可信身份的 Express Request，只在 Guard 成功后存在。 */
export interface AuthenticatedRequest extends Request {
  userContext?: UserContext;
}

/** 显式标记健康检查、指标和开发预置列表等公共路由。 */
export const PublicRoute = (): ClassDecorator & MethodDecorator =>
  SetMetadata(PUBLIC_ROUTE_METADATA, true);

@Injectable()
export class AuthenticationGuard implements CanActivate {
  public constructor(
    @Inject(AUTH_PORT) private readonly authPort: AuthPort,
    @Inject(SECURITY_AUDIT) private readonly audit: SecurityAuditPort,
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  public async canActivate(executionContext: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_METADATA, [
      executionContext.getHandler(),
      executionContext.getClass(),
    ]);
    if (isPublic) return true;

    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();
    try {
      request.userContext = await this.authPort.authenticate({
        headers: request.headers,
        ...(request.socket.remoteAddress ? { remoteAddress: request.socket.remoteAddress } : {}),
      });
      return true;
    } catch (error) {
      const authError =
        error instanceof AuthenticationError
          ? error
          : new AuthenticationError('AUTH_INVALID', '认证信息无法验证');
      try {
        await this.audit.appendAuthenticationDenied({
          requestId: this.requestContext.getRequestId(),
          action: 'AUTHENTICATION',
          resourceType: 'HTTP_REQUEST',
          result: 'DENIED',
          reason: authError.code,
        });
      } catch {
        // 审计存储异常不能把认证失败改成放行；原始 Token 从未进入审计事件。
      }
      throw authError;
    }
  }
}

/** 控制器参数装饰器只读取 Guard 建立的上下文；缺失时继续 fail-closed。 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, executionContext: ExecutionContext): UserContext => {
    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.userContext) throw new AuthenticationError('AUTH_REQUIRED', '缺少认证信息');
    return request.userContext;
  },
);
