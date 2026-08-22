/**
 * Prometheus 指标注册表和 HTTP 请求指标。
 * 指标标签只使用方法、路由模板和状态码，禁止放 userId/documentId 等高基数字段。
 *
 * @requirement BASE-008
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

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

  /** 独立 Node Parser 只按格式和稳定结果聚合，禁止把文件名或来源 URL 放入标签。 */
  public readonly m03ParserRunsTotal = new Counter({
    name: 'rag_m03_parser_runs_total',
    help: 'M03 独立 Node Parser 调用累计次数',
    labelNames: ['format', 'result'] as const,
    registers: [this.registry],
  });

  /** 独立 Node Parser 的格式级耗时，用来识别 PDF/Office 热点。 */
  public readonly m03ParserDurationSeconds = new Histogram({
    name: 'rag_m03_parser_duration_seconds',
    help: 'M03 独立 Node Parser 解析耗时（秒）',
    labelNames: ['format', 'result'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [this.registry],
  });

  /** M04 固定标签只记录质量结论或失败分类，不记录文档、用户和规则内容。 */
  public readonly m04ProcessingTotal = new Counter({
    name: 'rag_m04_processing_total',
    help: 'M04 知识加工与质量门禁结果累计次数',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  /** M04 单文档结构恢复、Chunk 和质量检查端到端耗时。 */
  public readonly m04DurationSeconds = new Histogram({
    name: 'rag_m04_processing_duration_seconds',
    help: 'M04 单文档知识加工耗时（秒）',
    labelNames: ['result'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });

  /** M05 只记录固定操作与结果标签，不暴露 Profile、空间、文档或 Collection 名。 */
  public readonly m05OperationsTotal = new Counter({
    name: 'rag_m05_operations_total',
    help: 'M05 向量化、索引、发布和维护操作累计次数',
    labelNames: ['operation', 'result'] as const,
    registers: [this.registry],
  });

  /** M05 单文档从 Embedding 到原子发布的端到端耗时。 */
  public readonly m05DurationSeconds = new Histogram({
    name: 'rag_m05_indexing_duration_seconds',
    help: 'M05 向量化、索引、对账与发布耗时（秒）',
    labelNames: ['result'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900],
    registers: [this.registry],
  });

  /** M06 固定操作标签，不记录 userId、conversationId、runId、Ticket 或问题正文。 */
  public readonly m06OperationsTotal = new Counter({
    name: 'rag_m06_operations_total',
    help: 'M06 会话、Run、事件、取消和维护操作累计次数',
    labelNames: ['operation', 'result'] as const,
    registers: [this.registry],
  });

  /** 当前 SSE 连接数按认证传输方式聚合，用于发现连接激增。 */
  public readonly m06SseConnections = new Gauge({
    name: 'rag_m06_sse_connections',
    help: 'M06 当前活跃 SSE 连接数',
    labelNames: ['transport'] as const,
    registers: [this.registry],
  });

  /** PG Outbox 到 Redis Stream 的事件发布延迟。 */
  public readonly m06EventPublishLagSeconds = new Histogram({
    name: 'rag_m06_event_publish_lag_seconds',
    help: 'M06 Run Event 从业务事务发生到 Redis Stream 可见的延迟',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
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
