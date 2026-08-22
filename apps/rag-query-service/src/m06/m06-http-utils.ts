/** M06 Query API 的可信访问上下文、Zod 校验与 Cookie 工具。 */
import { BadRequestException } from '@nestjs/common';
import type { AccessContext } from '@rag/application';
import type { UserContext } from '@rag/contracts';
import type { RequestContextService } from '@rag/observability';
import type { z } from 'zod';

/**
 * 把未知 HTTP 输入收窄成契约类型。
 * Zod 的字段细节只用于服务端定位问题；对外统一映射为 400，避免把内部 Schema 结构泄露给调用方。
 */
export function parseM06Input<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException('请求参数不符合 M06 接口契约');
  return result.data;
}

/** 从认证 Guard 与 AsyncLocalStorage 构造显式 AccessContext。 */
export function toAccessContext(
  user: UserContext,
  requestContext: RequestContextService,
): AccessContext {
  const traceId = requestContext.get()?.traceId;
  return {
    user,
    requestId: requestContext.getRequestId(),
    ...(traceId ? { traceId } : {}),
  };
}

/** 只解析指定 Cookie，不把完整 Cookie 或 Ticket 写入错误。 */
export function readCookie(rawCookie: string | undefined, name: string): string | undefined {
  if (!rawCookie) return undefined;
  for (const part of rawCookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
