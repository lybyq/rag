/**
 * 定义跨进程事件的版本化公共信封。
 * 事件 data 仍由各模块的 Zod Schema 决定，公共字段用于幂等、追踪和兼容性判断。
 *
 * @requirement BASE-006
 */
import { z } from 'zod';

/** 为具体事件数据创建统一的版本化运行时契约。 */
export function createEventEnvelopeSchema<TSchema extends z.ZodType>(
  dataSchema: TSchema,
): z.ZodObject<{
  eventId: ReturnType<typeof z.uuid>;
  eventType: z.ZodString;
  eventVersion: ReturnType<typeof z.int>;
  occurredAt: ReturnType<typeof z.iso.datetime>;
  producer: z.ZodString;
  traceId: z.ZodOptional<z.ZodString>;
  data: TSchema;
}> {
  return z.object({
    eventId: z.uuid(),
    eventType: z.string().min(1),
    eventVersion: z.int().positive(),
    occurredAt: z.iso.datetime(),
    producer: z.string().min(1),
    traceId: z.string().min(1).optional(),
    data: dataSchema,
  });
}

/** 通用事件类型；业务消费者应优先使用具体 Schema 推导出的窄类型。 */
export interface EventEnvelope<T> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  producer: string;
  traceId?: string;
  data: T;
}
