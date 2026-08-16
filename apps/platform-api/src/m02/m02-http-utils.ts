/** M02 Controller 共用的参数和 AccessContext 转换。 */
import type { AccessContext } from '@rag/application';
import type { UserContext } from '@rag/contracts';
import type { RequestContextService } from '@rag/observability';

/** 把只读可信身份与当前请求关联信息组合为显式应用上下文。 */
export function toAccessContext(
  user: UserContext,
  requestContext: RequestContextService,
): AccessContext {
  const current = requestContext.get();
  return {
    user,
    requestId: current?.requestId ?? requestContext.getRequestId(),
    ...(current?.traceId ? { traceId: current.traceId } : {}),
  };
}
