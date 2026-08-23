/**
 * M07 RetrievalTelemetryPort 的 Prometheus Adapter。
 *
 * 只使用固定路线、阶段、结果和原因码标签，不记录 userId、runId、问题或候选主键。
 *
 * @requirement RET-009
 * @requirement RET-016
 */
import { Inject, Injectable } from '@nestjs/common';
import type { RetrievalTelemetryPort } from '@rag/application';
import { MetricsService } from '@rag/observability';

/** 将 M07 领域事件转换为低基数 Prometheus 指标。 */
@Injectable()
export class M07TelemetryAdapter implements RetrievalTelemetryPort {
  public constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  public route(route: 'CHAT' | 'KNOWLEDGE' | 'CLARIFY' | 'REJECT'): void {
    this.metrics.m07RoutesTotal.inc({ route: route.toLowerCase() });
  }

  public cache(result: 'hit' | 'miss' | 'write_failed'): void {
    this.metrics.m07CacheTotal.inc({ result });
  }

  public retrievalRoute(route: 'DENSE' | 'SPARSE', result: 'success' | 'degraded'): void {
    this.metrics.m07RetrievalRoutesTotal.inc({ route: route.toLowerCase(), result });
  }

  public removed(reason: string, count: number): void {
    if (count > 0) this.metrics.m07RemovedCandidatesTotal.inc({ reason }, count);
  }

  public stage(stage: string, durationMs: number, result: 'success' | 'failure'): void {
    this.metrics.m07StageDurationSeconds.observe({ stage, result }, durationMs / 1_000);
  }
}
