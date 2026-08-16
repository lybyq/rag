/**
 * 定义健康检查输出和依赖探针接口。
 * 探针接口属于跨 Adapter 契约，因此不包含任何数据库或 SDK 类型。
 *
 * @requirement BASE-009
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';

/** 单个依赖的健康状态。 */
export const DependencyHealthSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative(),
  message: z.string().optional(),
});

/** 单个依赖健康状态类型。 */
export type DependencyHealth = z.infer<typeof DependencyHealthSchema>;

/** 服务存活/就绪数据，不包含请求信封。 */
export const ServiceHealthDataSchema = z.object({
  service: z.string().min(1),
  status: z.enum(['up', 'degraded', 'down']),
  checkedAt: z.string().datetime(),
  uptimeSeconds: z.number().nonnegative(),
  dependencies: z.array(DependencyHealthSchema),
});

/** 服务健康数据类型。 */
export type ServiceHealthData = z.infer<typeof ServiceHealthDataSchema>;

/** 服务健康响应的完整 API 契约。 */
export const ServiceHealthEnvelopeSchema = createApiEnvelopeSchema(ServiceHealthDataSchema);

/** 服务健康响应类型。 */
export type ServiceHealthEnvelope = z.infer<typeof ServiceHealthEnvelopeSchema>;

/**
 * 外部依赖必须实现的最小健康探针。
 * Health 聚合器只认识此接口，因此不会依赖 PG、Redis、MinIO 或 Milvus SDK。
 */
export interface HealthProbe {
  readonly name: string;
  check(): Promise<DependencyHealth>;
}
