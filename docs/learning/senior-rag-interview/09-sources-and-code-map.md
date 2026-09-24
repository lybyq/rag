# 09｜公开资料、源码证据与边界索引

[返回目录](README.md)。核对日期：2026-09-24。公开资料只支撑所列技术点，不是这些厂商在生产中的全部架构，也不是面试真题来源。

## 1. 大厂公开工程资料

| 官方来源 | 本套手册参考的具体点 | 阅读用途 |
| --- | --- | --- |
| [AWS：RAG 与微调](https://docs.aws.amazon.com/prescriptive-guidance/latest/retrieval-augmented-generation-options/rag-vs-fine-tuning.html) | 外部知识与任务行为适配的区别 | Q02 选型回答，不把微调当检索故障修复器 |
| [Microsoft：RAG 信息检索阶段](https://learn.microsoft.com/azure/architecture/ai-ml/guide/rag/rag-information-retrieval) | 检索、融合与后续重排分层 | Q36–Q40 的分层理解 |
| [Azure AI Search：RRF](https://learn.microsoft.com/azure/search/hybrid-search-ranking) | 合并不同列表的排名，语义重排在其后 | Q37 的算法对照；手算例子为本手册自拟 |
| [Microsoft：Agentic retrieval](https://learn.microsoft.com/azure/search/agentic-retrieval-overview) | 查询规划、多查询执行、结果合成 | Q70 的扩展对照；版本和 preview/GA 状态以正式采用时为准 |
| [Microsoft：RAG 评估器](https://learn.microsoft.com/en-us/azure/foundry/concepts/evaluation-evaluators/rag-evaluators) | 过程检索质量与最终答案 groundedness 分开评估 | Q61，不能只报一个总分 |
| [Microsoft：端到端评测阶段](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/rag/rag-llm-evaluation-phase) | 将回答质量放回完整系统评测 | Q59–Q66 评测组织参考 |
| [Anthropic：Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) | 在检索表示中补充片段相关上下文 | Q18；不引用其收益比例作为本项目成果 |

## 2. GitHub 与基础设施官方资料

| 来源 | 参考点 | 不应误解为 |
| --- | --- | --- |
| [Docling](https://github.com/docling-project/docling) | 文档转换、结构化表示与复杂格式处理 | 已安装或已替换本项目 Parser |
| [RAGFlow](https://github.com/infiniflow/ragflow) | 完整 RAG 平台，可作为产品/解析方案对照 | 每一个功能都适合移植，或可直接替换现有内网依赖 |
| [FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding) | 检索向量模型与 Reranker 能力体系 | 内网部署已经暴露所有模型能力 |
| [Microsoft GraphRAG](https://github.com/microsoft/graphrag) | 图相关 RAG 方案 | 使用 LangGraph 就等于 GraphRAG |
| [LangGraph JS 工作流与 Agent](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents) | 固定工作流与动态工具过程的区别 | 框架自动解决权限、幂等和业务正确性 |
| [Milvus 全文检索](https://milvus.io/docs/full-text-search.md) | 内置 BM25 接受文本并依赖相应 Schema/Function | 与模型 SparseVector/IP 协议相同 |
| [Milvus BM25 Function](https://milvus.io/docs/bm25-function.md) | 文档和查询的文本分析与 BM25 处理 | Dense Embedding 必须提供 sparse |
| [Milvus HNSW](https://milvus.io/docs/hnsw.md) | 图索引参数及检索配置 | 当前参数已在本企业语料上最优 |
| [Milvus 一致性](https://milvus.io/docs/consistency.md) | 不同读一致性与可见性取舍 | 替代 PG 业务发布事务 |
| [BullMQ stalled](https://docs.bullmq.io/guide/jobs/stalled) | 心跳/锁失效后的任务恢复 | 每个业务副作用只发生一次 |
| [BullMQ 幂等任务](https://docs.bullmq.io/patterns/idempotent-jobs) | 重试不改变最终业务结果 | 只指定 jobId 就完成永久幂等 |
| [Ragas 指标](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/) | 检索、忠实度等不同评估维度 | 装上框架就获得真实金标 |
| [OpenTelemetry Traces](https://opentelemetry.io/docs/concepts/signals/traces/) | Span/Trace 表达调用与因果链 | 自动保存原文版本和业务快照 |
| [Late Chunking 原论文](https://arxiv.org/abs/2409.04701) | 在长上下文 token 表示之后、池化之前切分 | 普通句向量 endpoint 可以直接实现 |

本轮使用 agent-reach 的资料检索路由；其 Exa server 未配置，改用可用网页工具核对上述第一方文档与仓库。没有用论坛传闻替代技术依据，没有将外部百分比迁移成本项目指标。

## 3. 项目源码地图

新增专题另核对：[HyDE 原论文](https://arxiv.org/abs/2212.10496)、[RAPTOR 原论文](https://arxiv.org/abs/2401.18059)、[llm-wiki-compiler 官方仓库](https://github.com/atomicstrata/llm-wiki-compiler)、[LangGraph 持久化](https://docs.langchain.com/oss/javascript/langgraph/persistence)、[Anthropic Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)。这些分别支撑候选检索方法、Wiki 编译器选型、状态持久化和工作流/Agent 取舍；新增章节中的企业 ACL、发布、恢复与同步方案是结合本项目约束提出的设计，不声称第三方已全部实现。

以下链接均从当前文档位置指向仓库源码。先找导出函数，再找对应 spec；不要把文件头注释视为全部正确性证明。

| 能力 | 源码/证据 | 重点核对 |
| --- | --- | --- |
| Block 与表格契约 | [document-parsing.ts](../../../libs/contracts/src/document-parsing.ts) | originalText、位置空值、revision、rows/mergedCells |
| PDF 结构提取 | [pdf.parser.ts](../../../libs/document-parser-core/src/pdf.parser.ts) | 栏、标题推断、warning 和 OCR 目标 |
| Excel 结构 | [xlsx.parser.ts](../../../libs/document-parser-core/src/xlsx.parser.ts) | 区域、公式缓存、格式化与位置 |
| Word/PPT | [docx.parser.ts](../../../libs/document-parser-core/src/docx.parser.ts)、[pptx.parser.ts](../../../libs/document-parser-core/src/pptx.parser.ts) | relationship、实际顺序、媒体和定位 |
| OCR 合并与标准化 | [block-normalization.ts](../../../libs/parser-core/src/block-normalization.ts) | OCR 不覆盖原生事实、未知位置处理 |
| 结构恢复 | [structure-recovery.ts](../../../libs/chunking/src/structure-recovery.ts) | 标题栈、条款、FAQ、Sheet/Slide 边界 |
| Chunk 构建 | [chunk-builder.ts](../../../libs/chunking/src/chunk-builder.ts) | buildTableCandidates、renderTableRow、父子/来源关系 |
| Tokenizer | [tokenizer.ts](../../../libs/chunking/src/tokenizer.ts) | cl100k_base，不等于 GLM/BGE 精确 tokenizer |
| 质量规则 | [quality-policy.ts](../../../libs/chunking/src/quality-policy.ts) | 硬拒绝、人审、未知值与覆盖限制 |
| 向量批处理 | [embedding-batch.ts](../../../libs/retrieval/src/embedding-batch.ts) | itemId/Hash 对齐、部分失败、背压 |
| 向量 Adapter | [milvus-vector-index.adapter.ts](../../../libs/persistence-milvus/src/milvus-vector-index.adapter.ts) | 当前 HNSW/COSINE 与模型 Sparse/IP；BM25 差异 |
| 发布竞态 | [postgres-indexing.repository.ts](../../../libs/persistence-pg/src/postgres-indexing.repository.ts) | base_manifest_id、Head 比较、REBASE_QUEUED |
| 问题路由 | [query-routing.ts](../../../libs/retrieval/src/query-routing.ts) | 规则与 shouldUseLlmRewrite |
| 查询计划 | [query-plan.ts](../../../libs/retrieval/src/query-plan.ts) | 实体优先、字面量、子问题上限 |
| 查询缓存键 | [query-embedding-cache-key.ts](../../../libs/retrieval/src/query-embedding-cache-key.ts) | 只缓存向量事实，权限仍回源 |
| RRF | [weighted-rrf.ts](../../../libs/retrieval/src/weighted-rrf.ts) | rank、权重、去重、稳定平分 |
| 检索执行 | [hybrid-retrieval.graph.ts](../../../libs/rag-graph/src/hybrid-retrieval.graph.ts) | route/build_plan/hybrid_retrieve/source_recheck/retry |
| 证据组织 | [evidence-builder.ts](../../../libs/evidence/src/evidence-builder.ts)、[evidence-router.ts](../../../libs/evidence/src/evidence-router.ts) | 覆盖、冲突、受控回答路线 |
| 上下文预算 | [context-builder.ts](../../../libs/evidence/src/context-builder.ts) | SELF 优先、父子去重、估算和截断边界 |
| 有限计算 | [deterministic-calculation.ts](../../../libs/evidence/src/deterministic-calculation.ts) | 二元算术/日期差，不是财务引擎 |
| 答案执行 | [answer-generation.graph.ts](../../../libs/rag-graph/src/answer-generation.graph.ts) | 精排、再鉴权、可选 Judge、有限修复 |
| 答案规则 | [answer-validator.ts](../../../libs/answer/src/answer-validator.ts) | 规则覆盖和未覆盖的语义 |
| 评测口径 | [scorers.ts](../../../libs/evaluation/src/scorers.ts) | 文档级计分的局限、阈值不是测量结果 |
| 现有验收事实 | [优化验收记录](../../acceptance/intranet-rag-optimization-evidence.md) | PG 集成与真实内网评测未执行项 |
| 未来 Auto | [Agentic 计划](../../requirements/agentic-rag-auto-implementation-plan.md) | 尚未实现，不当作项目经历 |

## 4. 图形交付校验记录

三张图类型均为 workflow，使用 archify。最终 HTML 的拓扑/几何 showcase 校验均为 9/9 通过、0 错误、0 警告。生成规范与 HTML 的 SHA-256 如下，可用 Get-FileHash 复核：

| 图 | JSON SHA-256 | HTML SHA-256 |
| --- | --- | --- |
| offline | 8256311f56b21c853eda809188c3f76936e354e8e83dba743f8f3300aa08a778 | 5639b57702cde12140705e8c28ac52e447055e9470d18eb3450b55caa1770cb9 |
| online | ced6d03c9fcfe75d3c3470479617e27ea4934ae9955ae593f866b1bfd9f6ed5c | 6b21dd9292c7904a4083efc2e8d08e307e875c9a2e51799b7a4085f0f96a95c7 |
| trace | c223a4fb39bd2d432e906d9bc3be0a9ab056abfcd49e475acf4bd2e1b9d08f05 | 9a9a787bbc247339db5c7c826c76a80e7e77947a6392407ad4f73b7f764914ec |

视觉检查在 1440×900、1600×1000、1920×1080、2048×1320 执行，发现纵向滚动，故未通过“桌面一屏无滚动”门禁；未隐藏或裁剪页面冒充通过。已人工查看三图截图，图可阅读，但完整图及说明需向下滚动；visual-check JSON 保留在 diagrams 中，不称为全量视觉验收通过。浅/深色截图已生成，未逐张人工审阅。工具默认图例中的“Agent 逻辑”是通用后台节点类别，本文这些节点不意味着自主 Agent 已实现。

图中在线 BM25 是用户确认的内网能力与现有后续链路的教学组合，不是声称本地 Adapter 已验证该集成。几何检查通过不代替部署实测。
