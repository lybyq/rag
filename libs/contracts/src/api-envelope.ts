/**
 * 定义所有 HTTP API 共用的成功与失败信封。
 * 该文件保持纯 TypeScript/Zod，不依赖 NestJS，供后端、前端和测试共同复用。
 *
 * @requirement BASE-006
 * @requirement BASE-007
 */
import { z } from 'zod';

/** 客户端可以稳定处理的基础错误码。业务模块后续只允许追加，不能改变已有含义。 */
export const BaseErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'INTERNAL_ERROR',
]);

/** 基础错误码联合类型，由运行时 Zod Schema 推导，避免重复维护。 */
export type BaseErrorCode = z.infer<typeof BaseErrorCodeSchema>;

/** API 错误响应的唯一运行时契约。 */
export const ApiErrorSchema = z.object({
  requestId: z.string().min(1),
  traceId: z.string().min(1).optional(),
  code: BaseErrorCodeSchema.or(z.string().min(1)),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** API 错误响应类型。 */
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * 为具体数据 Schema 创建统一成功信封。
 *
 * @param dataSchema 业务数据的 Zod Schema
 * @returns 包含 requestId、data 与可选 meta 的新 Schema
 */
export function createApiEnvelopeSchema<TSchema extends z.ZodType>(
  dataSchema: TSchema,
): z.ZodObject<{
  requestId: z.ZodString;
  traceId: z.ZodOptional<z.ZodString>;
  data: TSchema;
  meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}> {
  return z.object({
    requestId: z.string().min(1),
    traceId: z.string().min(1).optional(),
    data: dataSchema,
    meta: z.record(z.string(), z.unknown()).optional(),
  });
}

/** 通用成功信封类型，具体业务类型通过泛型传入。 */
export interface ApiEnvelope<T> {
  requestId: string;
  traceId?: string;
  data: T;
  meta?: Record<string, unknown>;
}
