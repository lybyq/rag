# ADR-015：证据优先的结构化生成与严格发布门禁

- 状态：Accepted
- 日期：2026-08-25
- 决策者：RAG 平台团队
- 关联需求：ANS-001～ANS-020

## 背景

混合检索只能证明“找到了一些候选”，不能证明答案中的每个结论都有依据。企业问答还会遇到
来源撤权、文档换版、制度冲突、金额/日期算错、Prompt Injection、模型伪造引用以及生成中途
把未校验文本流给用户等问题。让 LLM 同时负责检索、判断权限、计算和最终放行，无法形成稳定
回归，也不能解释为什么回答、部分回答或拒答。

## 决策

1. `libs/rag-graph/src/answer-generation.graph.ts` 使用固定 LangGraph 状态机编排答案链；LLM 不是
   自由 Agent，不能选择 SQL、Milvus Filter、权限或最终状态。
2. 专用 Reranker 先精排候选。其超时只在配置允许时回退到 RRF 次序，并标记 degraded。
3. PostgreSQL 从已复核候选扩展 Parent、Previous、Next、Table Header；所有关系仍检查当前 ACL、
   Manifest、文档版本、content revision 和生效窗口。
4. EvidenceBuilder 为每个来源生成不透明 UUID，计算子问题覆盖、权威度、缺失条件、冲突和置信度。
5. Evidence Router 只有七条固定路线：`ANSWER`、`LLM_RERANK`、`REWRITE_AND_RETRY`、`CLARIFY`、
   `CONFLICT`、`PARTIAL_ANSWER`、`REJECT`。模型不能选择路线。
6. LLM 只返回 Zod 校验的 `AnswerDraft`，每个 Claim 至少引用一个已有 sourceId；金额、日期和
   白名单算术由代码生成带来源的计算事实。
7. Validator 在发布前重新鉴权并检查引用、版本、生效期、关键字面量、覆盖和冲突。Semantic
   Judge 只判断规则无法确定的语义 Claim，且不能覆盖确定性阻断项。
8. 可修复草稿最多再生成一次；第二次仍不通过即拒答。严格模式只发送阶段事件，最终正文、引用、
   校验报告和 Run 完成事件在一个 PostgreSQL 事务中提交。
9. 引用预览每次重新鉴权，只返回最多 2000 字符摘录；反馈记录有用/无用、稳定错误类型和说明，
   通过 assistant message 关联 Run、证据包、引用和模型版本。

## 取舍

- 优点：权限和事实校验可回归；答案状态可解释；模型故障可控；反馈能直接进入离线评测。
- 代价：一次回答包含更多数据库复核与结构化模型调用，首字延迟高于直接 Token Streaming。
- 未采用“边生成边展示”：无法撤回已经泄漏的错误金额、敏感内容或伪造引用。
- 未让 Semantic Judge 检查全部 Claim：确定性可判断的问题交给代码更稳定、便宜且可审计。
- 未把来源主键暴露为 citationId：不透明 UUID 能阻止客户端猜测 Chunk 或跨 Run 拼接引用。

## 后果

- 生产容量评测必须把 Reranker、生成、Judge 和两次 PG 复核纳入端到端 P95。
- Prompt、Validator、模型和 Reranker revision 都要冻结到 Run 或答案报告中。
- 内网切换只替换 `RerankerPort`、`AnswerModelPort` 和已有存储 Adapter，不修改领域规则和图边。

## 2026-09-13 延迟预算与上下文收敛

1. Rewrite、答案生成、LLM 证据重排和 Semantic Judge 使用独立调用预算，均不能突破 Run 总
   Deadline。剩余时间不足时跳过可选增强；修复生成预算不足时把 `REGENERATE` 收敛为拒答，
   不发布未通过校验的草稿。
2. ContextBuilder 先保证各子问题的直接证据，再在总 Token Budget 内按覆盖需要提高单文档配额；
   Parent/Neighbor 与已选窗口大面积重叠时去重或只保留新增片段。
3. 模型上下文显式携带标题路径、内容 revision 和适用期，Prompt 要求先直接回答，再说明必要
   条件、例外、冲突和引用。严格发布门禁保持不变。
