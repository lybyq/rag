# 内网问答与多文件发布优化代码走读

关联 `OPT-002`～`OPT-013`。本文按一次真实请求的执行顺序说明输入、输出、解决的问题和排障点。

## 1. 多文件上传为什么以前会“都成功了，但只查到一部分”

浏览器把多个文件放进同一 Upload Session，每个文件分别直传 MinIO，再分别调用 complete。数据库 complete 会锁 Upload Session 和当前文件，所以两个文件不会抢着把同一个上传记录改坏；每个文件也会原子创建自己的 Document、Version、十步 Job 和 Outbox。

真正的竞态发生在更后面的发布阶段：A、B 两个文件几乎同时开始索引时，都可能看到同一个旧 Head Manifest。A 生成“旧 Head + A”，B 生成“旧 Head + B”。如果二者都无条件把自己设为 Head，最后发布的 B 会把 A 从在线成员集合中覆盖掉。A 的 Job 看起来成功，向量也存在，但新问题绑定 B 的 Head 后看不到 A。

现在 `indexing_runs.base_manifest_id` 保存构建开始时看到的 Head。发布时 PostgreSQL 在事务内重新锁空间并比较当前 Head：

1. 当前 Head 仍等于 base：正常原子发布。
2. 当前 Head 已变化：说明别的文件先发布了；本次旧候选不能切 Head。
3. 系统把旧候选标成失败、清掉未公开向量、把 Job 退回 WAITING，并通过 Outbox 重新请求索引。
4. 重跑基于最新 Head 复制所有在线成员，再加入自己的文档版本，最后重新对账并发布。

这叫 Compare-And-Swap 加 rebase。它解决的是“并发更新集合时丢成员”，不是简单给整个向量化过程加大锁。远程 Embedding/Milvus 可能很慢，如果从开始到结束一直锁空间，会把同空间其他上传、回滚和发布全部堵住。

排障时先看 `indexing_runs.rebase_count`、`base_manifest_id`，再看 Job 是否出现 `REBASE_QUEUED` 和新的 `ingestion.indexing.requested`。出现一次 rebase 是正常并发恢复，不是知识丢失。

## 2. 检索结果、证据和最终回答为什么必须分层

一次问题依次经历：授权空间快照 → Query Plan → Dense/Sparse 检索 → PG 回源复核 → BGE 重排 → 父块/相邻块扩展 → Evidence Bundle → Token 裁剪后的 Answer Context → GLM Draft → 规则/Judge 校验 → 发布答案。

“Milvus 命中”只说明向量相似，不能直接成为引用。PG 回源会再次检查 chunk、documentVersion、document、space 和当前 Manifest；Evidence 会检查问题覆盖和可比较冲突；Context 还会受 Token 与单文档配额限制。因此排障必须分别看：

- 候选为零：查问题向量、Profile、Manifest 和 Milvus Filter。
- 有候选但回源后为零：查 ACL、版本、Manifest 成员或数据库映射。
- 有材料但 Evidence 缺失：查问题覆盖依据和重排分数，不要直接降全局阈值。
- Evidence 正确但 Context 未包含：查 Token 预算、每文档配额和 omittedSourceIds。
- Context 正确但 Draft 错：查 GLM 输出、截断、引用 ID 和生成提示词。
- Draft 有依据却拒答：查 Validator 的引用、数字、覆盖、冲突和语义错误码。

`ContextBuilder` 现在优先保留真正回答问题的 SELF 块，再放辅助父/相邻块；生成、计算和校验使用同一份实际可见 Context，不再出现“完整 Bundle 中有原文，所以校验通过，但模型其实没见过”的错位。最终正文由通过校验的 Claims 组合，不能让未经校验的 summary 绕过门禁。

## 3. Judge 关闭后为什么仍然安全

BGE Reranker 和 LLM Evidence Rerank 是两件事。前者是专用相关性模型，仍然执行；后者是可选的额外 LLM 调用。`ANSWER_LLM_EVIDENCE_RERANK_ENABLED=false` 只省掉后者。

`ANSWER_SEMANTIC_JUDGE_ENABLED=false` 时，生成端被约束为 DIRECT Claim：答案文字必须能在当前可见证据中确定性核对，引用、权限、版本、数字规则仍全部执行。需要同义推断但无法直接核对的内容只能部分回答或说明限制，不能把 SEMANTIC 标签改个名字冒充通过。

这两个开关都关闭可以减少两次串行模型等待，适合先在内网演示和做性能基线。但复杂综合问题的质量是否够用必须通过业务集评测决定，不是“关了肯定更好”。新 Run 会冻结开关快照；数据库系统/空间 Feature Flag 可能覆盖 env，所以改 env 后要查看新 Run 快照，不能只看配置文件。

## 4. GLM-4.7/vLLM、BGE 和 OCR 怎么适配

GLM/vLLM 的 `message.content` 才进入结构化答案解析；`reasoning_content` 只代表供应商推理字段，不能成为引用事实。非正常 `finish_reason` 归为部分结果，`content=null` 且只有推理文本归为 Schema 错误。答案生成、额外重排和 Judge 使用独立输出 Token 预算，避免一个短判断也按长答案等待。

BGE Reranker 的 `score` 必须先确认是 probability 还是 raw logit。Adapter 校验 candidateId、数量和 1～N rank，并按 rank 排序。probability 必须位于 0～1；logit 只在 Adapter 内做一次稳定 Sigmoid。Evidence 层不再二次归一化。

OCR 的响应模式由 env 明确选择。纯文本响应没有页内坐标和置信度，就保留 `null` 并发出能力告警；不能填 0 让好文字被质量规则误杀，也不能填 1 冒充高质量。一次纯文本调用只能对应一个目标，避免把整份 PDF 的文字复制到每一页。由于当前没有真实请求样例，请求是 URL、文件还是 Base64 仍属于内网联调门禁。

## 5. 用户看到的为什么叫“处理说明”，不叫“思考过程”

模型隐藏推理既不稳定，也可能包含不该展示的信息。前端展示的是后端真实事件：授权后检索了哪些用户可见空间、回源后有多少份可访问资料、Context 实际保留多少证据、何时开始校验、等待多久以及能否取消。

`run.progress` 与步骤事实一起持久化，包含单调 sequence、服务端时间、阶段、状态和授权后计数。SSE 断开后按 sequence 轮询重放并去重；心跳只证明连接仍活着，不增加候选数或进度。前端空间名称还会与当前可见空间求交集，权限已变化或无法确认时使用不带名称的安全文案。

## 6. 外部批量 API 和页面阶段展示

`POST /api/v1/spaces/{spaceId}/document-batches` 复用 Upload Session 作为 batchId，不创建第二套状态机。`GET /api/v1/document-batches/{batchId}` 最多五路并发查询各文件事实：未完成上传时 jobId 必须是 null；完成后返回真正的 Document、Version、Job、步骤和百分比。

页面在每个文件 complete 返回 jobId 后直接打开十步 Job 详情，不等待三秒列表轮询“碰巧”找到它。其他并发文件仍保留在队列和任务列表中。阶段百分比、处理单位、跳过、等待审核、失败、取消和重处理全部来自后端；浏览器只计算已经上传到对象存储的字节进度。

外部批次要求 `externalSourceId + externalDocumentId + sha256`，并用 Header `Idempotency-Key` 绑定规范化请求 Hash。同键同请求返回原批次，同键不同请求报 409；不同批次再次提交相同外部主键和内容 Hash 会复用原 Document/Version/Job，内容变化则在同一 Document 下创建新 Version。旧版仍由当前 Manifest 服务，直到新版索引对账并原子发布。`clientFileId` 仍只是单批次临时关联，不能冒充长期文档主键。

## 7. 面试深挖时怎么回答取舍

问“为什么不用一个大事务包含 MinIO、Embedding、Milvus”：这些系统不共享 ACID 事务；长事务还会持锁。项目用 PG 状态事实、Outbox、BullMQ 重试、幂等键、候选 Manifest、对账和原子 Head 切换实现最终一致性。

问“为什么来源还会错”：向量相关不等于业务事实正确；必须把候选、回源授权、版本、Evidence、Context 和 UI citationId 分层核对。同名文档只能靠稳定 ID 与 Manifest 关联，不能靠标题或数组下标。

问“Dense-only 能不能上线”：能否上线由业务 Recall/Precision 和延迟决定，不由“混合检索听起来更高级”决定。Sparse 服务没部署好时显式 Dense-only 比写空稀疏向量更安全；后续要补历史稀疏向量、对账、评测并灰度新 Profile，不能只把查询权重从 0 改成 0.8。

问“如何证明修好了”：代码测试证明控制流和不变量，PG 集成测试证明并发事务，Provider 合成契约测试证明形状处理；真实内网模型的准确率、P50/P95、OCR 质量和并发容量必须再用固定脱敏集实测，三者不能互相冒充。
