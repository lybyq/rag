/** M01 控制器共用的 Zod 校验和响应信封工具。 */
import { BadRequestException } from '@nestjs/common';
import type { ApiEnvelope } from '@rag/contracts';
import type { RequestContextService } from '@rag/observability';
import type { z } from 'zod';

/** 不把 Zod 详细内部结构直接返回客户端，只交给稳定全局错误映射。 */
export function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException('请求参数不符合约定');
  return result.data;
}

/** 使用 AsyncLocalStorage 中的 requestId/traceId 构造统一成功信封。 */
export function envelope<T>(requestContext: RequestContextService, data: T): ApiEnvelope<T> {
  const context = requestContext.get();
  return {
    requestId: context?.requestId ?? requestContext.getRequestId(),
    ...(context?.traceId ? { traceId: context.traceId } : {}),
    data,
  };
}
