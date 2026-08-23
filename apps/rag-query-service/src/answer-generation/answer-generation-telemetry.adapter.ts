/**
 * 证据、生成与答案校验 Prometheus Adapter。
 *
 * 只记录固定路由、校验结果、阶段和降级码，禁止使用 runId、userId、sourceId 或正文标签。
 *
 * @requirement ANS-004
 * @requirement ANS-016
 */
import { Inject, Injectable } from '@nestjs/common';
import type { AnswerGenerationTelemetryPort } from '@rag/application';
import { MetricsService } from '@rag/observability';

/** 答案工作流的低基数监控实现。 */
@Injectable()
export class AnswerGenerationTelemetryAdapter implements AnswerGenerationTelemetryPort {
  public constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  public route(route: string): void {
    this.metrics.answerEvidenceRoutesTotal.inc({ route: route.toLowerCase() });
  }

  public validation(outcome: string): void {
    this.metrics.answerValidationTotal.inc({ outcome: outcome.toLowerCase() });
  }

  public degradation(reason: string): void {
    this.metrics.answerDegradationsTotal.inc({ reason });
  }

  public stage(stage: string, durationMs: number, result: 'success' | 'failure'): void {
    this.metrics.answerStageDurationSeconds.observe({ stage, result }, durationMs / 1_000);
  }
}
