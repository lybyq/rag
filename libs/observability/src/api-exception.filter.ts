/**
 * 把 NestJS/未知异常转换成稳定、脱敏的 API 错误契约。
 * 客户端只能依赖 code、retryable 等稳定字段，不能依赖底层 SDK 的错误文本。
 *
 * @requirement BASE-007
 * @requirement BASE-008
 */
import {
  type ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ApiError, BaseErrorCode } from '@rag/contracts';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { RequestContextService } from './request-context';

interface ErrorMapping {
  code: BaseErrorCode;
  message: string;
  retryable: boolean;
}

/** 根据 HTTP 状态码选择对外稳定的错误语义。 */
function mapStatus(status: number): ErrorMapping {
  if (status === HttpStatus.BAD_REQUEST || status === HttpStatus.UNPROCESSABLE_ENTITY) {
    return { code: 'VALIDATION_ERROR', message: '请求参数不符合约定', retryable: false };
  }
  if (status === HttpStatus.NOT_FOUND) {
    return { code: 'NOT_FOUND', message: '请求的资源不存在', retryable: false };
  }
  if (status === HttpStatus.SERVICE_UNAVAILABLE) {
    return { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用', retryable: true };
  }
  if (status === HttpStatus.REQUEST_TIMEOUT || status === HttpStatus.GATEWAY_TIMEOUT) {
    return { code: 'DEADLINE_EXCEEDED', message: '请求处理超时', retryable: true };
  }
  return { code: 'INTERNAL_ERROR', message: '服务内部错误', retryable: false };
}

/** 应用于全部 HTTP 路由的最后一道异常边界。 */
@Catch()
@Injectable()
export class ApiExceptionFilter implements ExceptionFilter {
  public constructor(
    @Inject(RequestContextService) private readonly requestContext: RequestContextService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ApiExceptionFilter.name);
  }

  public catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const mapping = mapStatus(status);
    const context = this.requestContext.get();
    const body: ApiError = {
      requestId: context?.requestId ?? this.requestContext.getRequestId(),
      ...(context?.traceId ? { traceId: context.traceId } : {}),
      ...mapping,
    };

    this.logger.error(
      {
        err: exception,
        requestId: body.requestId,
        traceId: body.traceId,
        errorCode: body.code,
        httpStatus: status,
      },
      'HTTP 请求处理失败',
    );
    response.status(status).json(body);
  }
}
