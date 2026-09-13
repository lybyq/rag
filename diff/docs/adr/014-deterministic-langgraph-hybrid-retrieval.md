# ADR-014：查询规划与混合检索 使用确定性 LangGraph 子图编排混合检索

- 状态：Accepted
- 日期：2026-08-24
- 决策者：RAG 平台团队
- 关联需求：RET-001～RET-017

## 背景

会话运行与事件 已有 PostgreSQL Run/Step 事实、Redis 顺序事件和 AbortSignal，但尚未实现问题规划与检索。
企业问答需要可解释的路由、严格权限边界、最多两轮检索和单路安全降级。如果直接使用开放式 Agent，
模型可能选择未批准的工具、形成无界循环，或把文本拼成 SQL/Milvus Filter，这与默认拒绝原则冲突。

## 决策

1. 在 `libs/rag-graph/src/hybrid-retrieval.graph.ts` 使用 `@langchain/langgraph` 的 `StateSchema`、
   `StateGraph`、条件边、回边和 `compile()` 实现真正的 查询规划与混合检索 检索子图。
2. 图路径固定为：`route_query → build_plan → (rewrite_query?) → query_embedding →`
   `hybrid_retrieve → source_recheck → assess_retrieval → (retry_plan → query_embedding)? → diversify`。
3. LangGraph 在这里承担状态与控制流编排，不把模型包装成自由 Agent。LLM 只输出
   `rewrittenQuery/subQuestions/entities`，经 Zod 校验后由代码重建精确字面量和 Filter。
4. Dense/Sparse 在 `hybrid_retrieve` 节点内使用 `Promise.allSettled` 真并行。至少一路成功才继续。
5. 图回边只能从 `retry_plan` 回到 `query_embedding`，`round` 仅为 1/2，第二轮不再调用 LLM。
6. 查询规划与混合检索 子图不自行完成 会话运行与事件 Run。它返回受控候选给 证据与答案生成；当前授权调试 API 可独立执行子图。
7. 正文只从 PostgreSQL 批量回源。Milvus 仅返回 `vectorId/documentId/score`；PG 再检查当前权限、
   Manifest 版本与成员、文档/版本状态、发布时间和生效窗口。

## 取舍

- 优点：流程可回归；循环有硬上限；LLM 无权限控制权；证据与答案生成 能直接复用；阶段可独立观测。
- 代价：新增 LangGraph 依赖；状态字段需要显式维护；复杂分支要通过代码发布。
- 未采用开放式 ReAct Agent：它适合探索型工具调用，不适合权限和版本必须确定的在线检索主链。
- Dense/Sparse 没拆成两个图节点：在一个节点内汇合更容易形成原子的单路降级语义。

## 后果

- Profile/权重/TopK 变化必须进入新 Run 快照并执行黄金集回归。
- 证据与答案生成 只能消费 PG 回源通过的 `RetrievalCandidate`，不能用 Milvus 短摘要替代正文。
- 内网切换只替换 QueryRewritePort、EmbeddingPort 和 VectorIndexPort Adapter，不修改图节点。

## 2026-09-13 性能与候选质量收敛

1. Query Embedding 缓存保存的只是模型向量，不包含检索命中。因此缓存键改为真实送入模型的
   文本 Hash、模型/revision、维度、归一化、输出模式、Sparse 格式和查询模板版本；Run 时间、
   完整 Plan Hash、用户及权限范围不再进入键。缓存命中后仍完整执行 Milvus Filter 和 PostgreSQL
   当前 ACL、Manifest、文档版本、发布时间与生效期复核，不能复用检索结果绕过权限。
2. `initialTopK` 用于每路召回，`candidatePoolTopK` 用于融合、回源和多样性后的 Reranker 输入，
   `finalTopK` 只在精排后裁剪。三者必须满足 `finalTopK <= candidatePoolTopK <= initialTopK`。
3. 多子问题与多空间形成的 Dense/Sparse 远程请求以 Run 快照中的 `maxConcurrency` 受控并发；
   Deadline 与 AbortSignal 语义保持不变。
4. 第二轮规则生成的查询若与首轮已有查询归一化后完全相同，则记录
   `RETRY_QUERY_UNCHANGED` 并跳过重复向量化和检索。
