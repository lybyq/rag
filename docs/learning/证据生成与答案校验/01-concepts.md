# 证据生成与答案校验：核心概念

## 为什么“检索到了”不等于“可以回答”

检索分数只表示文本相似。企业答案还要回答四个问题：当前用户现在能否读、该版本是否仍有效、
多个来源是否冲突、答案中的每个 Claim 是否真的被引用支持。第八阶段把候选升级为可审计 Evidence，
再把模型输出降级为待审查 Draft。

## 五个关键对象

1. `RerankResponse`：专用相关性模型的排序事实，带 modelId/revision。
2. `EvidenceBundle`：有效来源、覆盖、冲突、缺失条件、置信度和 bundle hash。
3. `AnswerDraft`：模型可写的唯一形状；summary、claims、caveats、follow-up。
4. `ValidationReport`：代码与必要的 Semantic Judge 得出的门禁结论。
5. `FinalAnswer`：服务端根据 Route 和 Report 产生的五种用户状态。

## 三条信任边界

- Milvus/Reranker/LLM 都不是权限事实源；权限、Manifest 和版本只由 PostgreSQL 复核。
- sourceId 是服务端随机 UUID；模型只能引用现有 UUID，不能提交 Chunk 主键。
- Semantic Judge 只能处理语义支持，不能覆盖撤权、过期、伪造引用、计算错误或来源冲突。

## 为什么严格模式不做 Token Streaming

Token 一旦发给客户端就无法撤回。若后续才发现引用伪造或金额错误，系统已经发生信息泄漏。
因此 SSE 先发 `run.step_started/completed`，最终正文和引用只有 Validator 完成后才原子发布。
