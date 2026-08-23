/**
 * 在线流量的分布式限流与并发舱壁端口。
 *
 * @requirement OPS-007
 * @requirement OPS-009
 */

/** 一次流控请求；key 必须是脱敏哈希，不能使用完整问题或 Token。 */
export interface TrafficControlRequest {
  readonly bucket: string;
  readonly key: string;
  readonly rateLimit: number;
  readonly rateWindowSeconds: number;
  readonly concurrencyLimit: number;
  readonly leaseSeconds: number;
}

/** 流控结果；允许时返回必须释放的租约 ID。 */
export type TrafficControlDecision =
  | { readonly allowed: true; readonly leaseId: string }
  | {
      readonly allowed: false;
      readonly retryAfterSeconds: number;
      readonly reason: 'RATE' | 'CONCURRENCY';
    };

/** 分布式流控 Port。 */
export interface TrafficControlPort {
  acquire(request: TrafficControlRequest): Promise<TrafficControlDecision>;
  release(leaseId: string): Promise<void>;
}

/** 依赖注入 Token。 */
export const TRAFFIC_CONTROL = Symbol('TRAFFIC_CONTROL');
