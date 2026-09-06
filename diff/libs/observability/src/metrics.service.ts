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
   * 文档接入与任务 关键业务动作计数器。
   *
   * 这里只允许使用固定枚举值作为标签，绝不能放入 userId、documentId、jobId 等高基数字段，
   * 否则每个文档都会创建一条新的 Prometheus 时间序列，最终可能拖垮监控系统。
   */
  public readonly documentIngestionOperationsTotal = new Counter({
    name: 'rag_document_ingestion_operations_total',
    help: '文档接入与任务 文档接入关键业务动作累计次数',
    labelNames: ['operation', 'result'] as const,
    registers: [this.registry],
  });

  /** 文件解析与OCR 只按稳定结果和步骤聚合，不把文件名、Job ID 或 Provider URL 放入标签。 */
  public readonly documentParsingOperationsTotal = new Counter({
    name: 'rag_document_parsing_operations_total',
    help: '文件解析与OCR 文件处理结果累计次数',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  public readonly documentParsingDurationSeconds = new Histogram({
    name: 'rag_document_parsing_duration_seconds',
    help: '文件解析与OCR 单文档端到端处理耗时（秒）',
    labelNames: ['result'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [this.registry],
  });

  /** 独立 Node Parser 只按格式和稳定结果聚合，禁止把文件名或来源 URL 放入标签。 */
  public readonly documentParserRunsTotal = new Counter({
    name: 'rag_document_parser_runs_total',
    help: '文件解析与OCR 独立 Node Parser 调用累计次数',
    labelNames: ['format', 'result'] as const,
    registers: [this.registry],
  });

  /** 独立 Node Parser 的格式级耗时，用来识别 PDF/Office 热点。 */
  public readonly documentParserDurationSeconds = new Histogram({
    name: 'rag_document_parser_duration_seconds',
    help: '文件解析与OCR 独立 Node Parser 解析耗时（秒）',
    labelNames: ['format', 'result'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [this.registry],
  });

  /** Parser 成功输出的正文字符规模；只使用有限格式标签，不记录文档名或正文。 */
  public readonly documentParserOutputCharacters = new Histogram({
    name: 'rag_document_parser_output_characters',
    help: '文件解析与OCR 独立 Node Parser 成功输出的 originalText 字符总数',
    labelNames: ['format'] as const,
    buckets: [0, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 50_000_000],
    registers: [this.registry],
  });

  /** Parser 成功读取的真实表格单元格数，用于容量阈值校准。 */
  public readonly documentParserTableCells = new Histogram({
    name: 'rag_document_parser_table_cells',
    help: '文件解析与OCR 独立 Node Parser 成功读取的真实表格单元格数',
    labelNames: ['format'] as const,
    buckets: [0, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 5_000_000],
    registers: [this.registry],
  });

  /** rowspan/colspan 或矩形补齐后的单元格数，单独展示结构放大倍数。 */
  public readonly documentParserExpandedTableCells = new Histogram({
    name: 'rag_document_parser_expanded_table_cells',
    help: '文件解析与OCR 独立 Node Parser 表格展开后的单元格数',
    labelNames: ['format'] as const,
    buckets: [0, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000],
    registers: [this.registry],
  });

  /** Parser 已验证的图片累计像素；未知尺寸不会伪装成零像素样本。 */
  public readonly documentParserPixels = new Histogram({
    name: 'rag_document_parser_pixels',
    help: '文件解析与OCR 独立 Node Parser 已验证的图片累计像素',
    labelNames: ['format'] as const,
    buckets: [1, 10_000, 1_000_000, 10_000_000, 100_000_000, 500_000_000],
    registers: [this.registry],
  });

  /** 知识加工与质量 固定标签只记录质量结论或失败分类，不记录文档、用户和规则内容。 */
  public readonly knowledgeProcessingOperationsTotal = new Counter({
    name: 'rag_knowledge_processing_operations_total',
    help: '知识加工与质量 知识加工与质量门禁结果累计次数',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  /** 知识加工与质量 单文档结构恢复、Chunk 和质量检查端到端耗时。 */
  public readonly knowledgeProcessingDurationSeconds = new Histogram({
    name: 'rag_knowledge_processing_duration_seconds',
    help: '知识加工与质量 单文档知识加工耗时（秒）',
    labelNames: ['result'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });

  /** 索引构建与发布 只记录固定操作与结果标签，不暴露 Profile、空间、文档或 Collection 名。 */
  public readonly indexingPublicationOperationsTotal = new Counter({
    name: 'rag_indexing_publication_operations_total',
    help: '索引构建与发布 向量化、索引、发布和维护操作累计次数',
    labelNames: ['operation', 'result'] as const,
    registers: [this.registry],
  });

  /** 索引构建与发布 单文档从 Embedding 到原子发布的端到端耗时。 */
  public readonly indexingPublicationDurationSeconds = new Histogram({
    name: 'rag_indexing_publication_duration_seconds',
    help: '索引构建与发布 向量化、索引、对账与发布耗时（秒）',
    labelNames: ['result'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900],
    registers: [this.registry],
  });

  /** 会话运行与事件 固定操作标签，不记录 userId、conversationId、runId、Ticket 或问题正文。 */
  public readonly conversationOperationsTotal = new Counter({
    name: 'rag_conversation_operations_total',
    help: '会话运行与事件 会话、Run、事件、取消和维护操作累计次数',
    labelNames: ['operation', 'result'] as const,
    registers: [this.registry],
  });

  /** 当前 SSE 连接数按认证传输方式聚合，用于发现连接激增。 */
  public readonly conversationSseConnections = new Gauge({
    name: 'rag_conversation_sse_connections',
    help: '会话运行与事件 当前活跃 SSE 连接数',
    labelNames: ['transport'] as const,
    registers: [this.registry],
  });

  /** PG Outbox 到 Redis Stream 的事件发布延迟。 */
  public readonly conversationEventPublishLagSeconds = new Histogram({
    name: 'rag_conversation_event_publish_lag_seconds',
    help: '会话运行与事件 Run Event 从业务事务发生到 Redis Stream 可见的延迟',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });

  /** 查询规划与混合检索 入口路由分布；标签是四个固定枚举，不包含问题原文。 */
  public readonly retrievalRoutesTotal = new Counter({
    name: 'rag_retrieval_routes_total',
    help: '查询规划与混合检索 确定性查询路由累计次数',
    labelNames: ['route'] as const,
    registers: [this.registry],
  });

  /** Dense/Sparse 路线成功与降级计数。 */
  public readonly retrievalChannelRoutesTotal = new Counter({
    name: 'rag_retrieval_channel_routes_total',
    help: '查询规划与混合检索 Dense/Sparse 检索路线结果累计次数',
    labelNames: ['route', 'result'] as const,
    registers: [this.registry],
  });

  /** 查询 Embedding 缓存命中、未命中和写降级计数。 */
  public readonly retrievalEmbeddingCacheTotal = new Counter({
    name: 'rag_retrieval_embedding_cache_total',
    help: '查询规划与混合检索 查询 Embedding 缓存结果累计次数',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  /** PG 回源复核移除计数，只记录稳定原因码。 */
  public readonly retrievalRemovedCandidatesTotal = new Counter({
    name: 'rag_retrieval_removed_candidates_total',
    help: '查询规划与混合检索 回源复核与安全门禁移除候选累计数',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  /** LangGraph 固定节点耗时，不使用 Run ID 等高基数标签。 */
  public readonly retrievalStageDurationSeconds = new Histogram({
    name: 'rag_retrieval_stage_duration_seconds',
    help: '查询规划与混合检索 LangGraph 节点执行耗时（秒）',
    labelNames: ['stage', 'result'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  /** 证据路由只有七个固定值，用于观察澄清、冲突、部分回答与拒答占比。 */
  public readonly answerEvidenceRoutesTotal = new Counter({
    name: 'rag_answer_evidence_routes_total',
    help: '证据、生成与答案校验 Evidence Router 路由累计次数',
    labelNames: ['route'] as const,
    registers: [this.registry],
  });

  /** Validator 结果只使用 PASS/REGENERATE/PARTIAL/REJECT 低基数标签。 */
  public readonly answerValidationTotal = new Counter({
    name: 'rag_answer_validation_total',
    help: '证据、生成与答案校验 Validator 结果累计次数',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  /** 可控降级原因计数，不包含 Provider URL、模型响应或资源标识。 */
  public readonly answerDegradationsTotal = new Counter({
    name: 'rag_answer_degradations_total',
    help: '证据、生成与答案校验 可控降级累计次数',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  /** 答案 LangGraph 固定节点耗时。 */
  public readonly answerStageDurationSeconds = new Histogram({
    name: 'rag_answer_stage_duration_seconds',
    help: '证据、生成与答案校验 LangGraph 节点执行耗时（秒）',
    labelNames: ['stage', 'result'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
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
