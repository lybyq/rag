/**
 * Prometheus 指标注册表和 HTTP 请求指标。
 * 指标标签只使用方法、路由模板和状态码，禁止放 userId/documentId 等高基数字段。
 *
 * @requirement BASE-008
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

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

  /**
   * M02 关键业务动作计数器。
   *
   * 这里只允许使用固定枚举值作为标签，绝不能放入 userId、documentId、jobId 等高基数字段，
   * 否则每个文档都会创建一条新的 Prometheus 时间序列，最终可能拖垮监控系统。
   */
  public readonly m02OperationsTotal = new Counter({
    name: 'rag_m02_operations_total',
    help: 'M02 文档接入关键业务动作累计次数',
    labelNames: ['operation', 'result'] as const,
    registers: [this.registry],
  });

  /** M03 只按稳定结果和步骤聚合，不把文件名、Job ID 或 Provider URL 放入标签。 */
  public readonly m03ProcessingTotal = new Counter({
    name: 'rag_m03_processing_total',
    help: 'M03 文件处理结果累计次数',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  public readonly m03DurationSeconds = new Histogram({
    name: 'rag_m03_processing_duration_seconds',
    help: 'M03 单文档端到端处理耗时（秒）',
    labelNames: ['result'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
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
