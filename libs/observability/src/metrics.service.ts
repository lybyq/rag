/**
 * Prometheus 指标注册表和 HTTP 请求指标。
 * 指标标签只使用方法、路由模板和状态码，禁止放 userId/documentId 等高基数字段。
 *
 * @requirement BASE-008
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

/** 为单个进程维护独立注册表，便于测试隔离和 worker 暴露指标。 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly registry = new Registry();
  public readonly httpDurationSeconds = new Histogram({
    name: 'rag_http_request_duration_seconds',
    help: 'RAG 服务 HTTP 请求耗时（秒）',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  public constructor() {
    this.registry.setDefaultLabels({ system: 'enterprise-rag' });
    collectDefaultMetrics({ register: this.registry });
  }

  /** 以 Prometheus 文本格式导出当前进程全部指标。 */
  public async render(): Promise<string> {
    return this.registry.metrics();
  }

  /** 返回 Prometheus 协议的 Content-Type。 */
  public get contentType(): string {
    return this.registry.contentType;
  }

  public onModuleDestroy(): void {
    this.registry.clear();
  }
}
