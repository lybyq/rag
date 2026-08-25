# 04：RAG 核心算法、LangGraph 与选型判断

## 1. RAG 的质量分解

最终答错不等于 LLM 差。可以把质量拆成：

```text
文档可用性 × 分块可检索性 × 召回率 × 排序精度 × 证据完整性 × 生成遵循度 × 校验能力
```

任意一项接近 0，最后都失败。排障必须先判断错在“没有生产出知识、没召回、排序错、上下文丢信息、模型乱答还是 Validator 误杀”。

## 2. 文档解析怎么选

| 场景            | 推荐                                   | 原因                     |
| --------------- | -------------------------------------- | ------------------------ |
| 数字化 PDF/DOCX | 原生 Parser 优先                       | 文本准确、快、保留结构   |
| 扫描 PDF/图片   | OCR                                    | 没有原生文字层           |
| 混合 PDF        | 按页选择性 OCR                         | 避免整本成本和覆盖好文本 |
| 表格密集 Excel  | 保留 Sheet/二维表/合并单元格           | 纯文本会丢行列关系       |
| PPT             | 保留 Slide、标题、文本框顺序和图片候选 | 页序与版面影响语义       |
| 复杂科研 PDF    | 可引入 layout/table 专用模型           | Node Parser 可能不足     |

先用可解释、低成本 Parser，只有 Golden 样本证明结构损失影响下游时才加重型模型。

## 3. Chunk 怎么选

### 3.1 固定字符切分

实现简单，适合纯文本和 Demo。缺点是切断标题、表格和条款，字符数也不等于模型 Token。

### 3.2 递归/Token 切分

按段落、句子、Token 上限递归，通用性较好。要设置 overlap，但 overlap 过大会导致索引膨胀和相似候选霸榜。

### 3.3 结构感知切分

按标题层级、条款、表格、Slide、Sheet 和代码块切，适合企业制度、手册、合同。实现更复杂，但引用和可解释性最好。

### 3.4 Parent/Child

Child 小块负责召回，Parent 大块负责生成。适合“精准命中一个条款，但回答需要上下文”的企业文档。本项目采用这种思路并保留 Neighbor 关系。

### 3.5 如何调大小

- 找不到精确条款：Child 可能太大或标题没有注入。
- 找到词但答案缺前提：生成上下文太小，需 Parent/Neighbor。
- 候选大量重复：overlap 太大或缺多样性限制。
- 表格答错行列：不要只调 Chunk size，应保留结构或生成行级 Chunk + 表头。
- 规章编号/金额召回差：加入 Sparse/字面量通道，不要只靠 Dense。

用真实问题集测 Recall@K 和答案正确率，不凭感觉选 500/1000 Token。

## 4. Dense、Sparse 和 Hybrid

### 4.1 Dense

把文本变成高维语义向量。优点是同义表达召回好；缺点是精确编号、稀有专有名词和数字可能不稳定。

### 4.2 Sparse/BM25

按词项匹配。优点是编号、错误码、产品名、原词精确；缺点是同义改写弱。

### 4.3 Hybrid

企业知识同时有自然语言和精确术语，通常混合最稳。本项目 Dense + Sparse 并行，使用 Weighted RRF 合并，而不是直接相加不同量纲的原始分数。

### 4.4 Weighted RRF 手算

公式：

```text
score(d) = Σ weight(channel) / (k + rank(channel, d))
```

假设 k=60，Dense 权重 0.65，Sparse 权重 0.35：

- 文档 A：Dense 第 1，Sparse 第 3。
- 文档 B：Dense 第 2，Sparse 第 1。

```text
A = 0.65/61 + 0.35/63 ≈ 0.01621
B = 0.65/62 + 0.35/61 ≈ 0.01622
```

B 略高，因为它在精确词通道第一，同时 Dense 也不差。RRF 只看名次，能抵抗不同模型分数尺度。

### 4.5 什么时候不用 Hybrid

- 数据极小且关键词固定：PG FTS/BM25 可能足够。
- 全是短商品编码：倒排/结构化查询比向量更可靠。
- 纯语义 FAQ 且术语少：Dense 可能够用。
- 没有可靠 Sparse 输出：先 Dense + 精确字面量，不要伪造 sparse。

## 5. Query Rewrite 和分解

Query Rewrite 适合口语、省略、代词和多轮上下文，但有“改坏原意”的风险。策略：保留原问题，改写只是额外检索通道；记录 rewrite revision；低复杂问题不必调用 LLM。

多跳问题可以拆 subquestion，例如“6000 元谁审批且多久报销”拆成审批规则和报销时限。证据冲突必须在同一 subquestion、可比章节和不同来源版本内判断，不能把不同章节的多个数字当成冲突。本项目真实演练修复过这个问题。

## 6. Filter 和权限

元数据过滤能缩小空间、部门、文档状态、时间和 Manifest。原则：

- Filter 来自服务端授权上下文和白名单字段。
- 用户输入不得直接成为 SQL/Milvus 表达式。
- 过滤过严导致 0 结果时，要能观测是哪条条件裁掉了候选。
- Milvus 过滤后回 PG 复核当前权限和版本。

权限过滤越靠前，泄漏面和无效计算越小；回源复核越靠后，正确性越强，所以采用前后双保险。

## 7. Reranker 怎么判断要不要上

适合：候选几十条、文档相似、Top3 顺序决定答案、能接受额外几十到几百毫秒。

可以不上：小知识库、TopK 本就稳定、延迟极严、模型资源不足。先做离线对比：看加入 Reranker 后 MRR/NDCG、答案正确率提升是否值得 P95 延迟和 GPU 成本。

Cross-Encoder 通常精度高但慢；轻量模型/LLM Rerank 更灵活但成本和稳定性不同。本项目把专用 Reranker 放主路径，LLM Evidence Rerank 只在证据路由需要时使用。

## 8. Evidence 为什么是独立层

检索 Candidate 的分数只是“可能相关”；Evidence 还需要：

- 当前授权和版本有效；
- 可定位到文档、页、章节和 Hash；
- 有足够上下文且不越 Token 预算；
- 关键字面量可校验；
- 冲突、过期、敏感状态明确；
- Citation ID 稳定且只在本 Run 白名单内。

没有 Evidence 层，Prompt 会直接拼原始 Chunk，后续无法可靠回答“这句话到底来自哪里”。

## 9. 什么时候回答、拒答、澄清或升级人工

| 状态                                | 动作                       |
| ----------------------------------- | -------------------------- |
| 证据充足、无冲突、权限有效          | ANSWER                     |
| 证据太少或覆盖不了关键 Claim        | ABSTAIN                    |
| 问题缺对象/时间/空间范围            | CLARIFY                    |
| 同一事实有有效冲突版本              | CONFLICT，展示冲突或转人工 |
| 命中安全/合规策略                   | REJECT/ESCALATE            |
| Reranker 失败但基础排序可接受       | 降级并记录 degraded        |
| 高风险领域的 Validator/Judge 不可用 | fail-closed                |

拒答率不是越低越好。企业 RAG 要优化“有依据时答对、没依据时不乱答”。

## 10. LangGraph 为什么适合这条链路

固定函数链适合步骤稳定、没有分支/重试的小系统。项目存在：查询路由、可选改写、检索重试、证据不足/冲突分支、可选 LLM Rerank、最多一次再生成、取消和逐节点观测，因此使用显式状态图更清楚。

查询图：

```text
route_query
  → build_plan
  → [rewrite_query]
  → query_embedding
  → hybrid_retrieve
  → source_recheck
  → assess_retrieval
  → [retry_plan → query_embedding]
  → diversify
```

答案图：

```text
retrieve → rerank → expand_evidence → build_evidence → route_evidence
  → [llm_evidence_rerank → route_evidence]
  → build_context → generate_draft → revalidate_citations
  → rule_validation → [semantic_judge] → final_validation
  → [最多一次 regenerate] → finalize
```

Graph 的 State 只保存节点间需要的可序列化事实；每个节点有清晰输入/输出和上限。不要把 LangGraph 当“自动 Agent 魔法”，本项目是确定性骨架中有限使用模型。

## 11. 缓存怎么选

可缓存：Query Embedding、相同 Profile/Manifest/授权版本下的检索候选、Provider metadata。

谨慎缓存：最终答案。用户、角色、空间、Manifest、Prompt、Policy、会话上下文任一变化都会影响正确性，Key 很复杂；高风险问答宁可不缓存。

缓存命中后仍要考虑权限撤销。可把 `authorizationVersion` 放入 Key，或在返回前 source recheck。

## 12. 选择方案的决策框架

遇到新 RAG 项目，按顺序问：

1. 业务风险：答错的损失多大？决定拒答、Judge 和审计强度。
2. 文档形态：原生文本、扫描、表格、图片各占多少？决定 Parser/OCR。
3. 数据规模与更新频率：决定 PG/pgvector/专用向量库和发布方式。
4. 查询类型：语义、编号、结构化、多跳比例？决定 Dense/Sparse/SQL/分解。
5. 权限粒度：空间、文档、段落还是字段？决定过滤和回源架构。
6. 延迟/吞吐预算：决定 TopK、Reranker、模型大小、缓存和同步/异步。
7. 内网资源：Provider 协议、GPU、并发、网络和离线制品能力。
8. 可评测数据：没有 Golden，任何“感觉更好”都不能安全发布。

先建立最小基线，再每次只改变一个变量做对照实验。不要同时换 Chunk、Embedding、Reranker 和 Prompt，否则指标变化无法归因。
