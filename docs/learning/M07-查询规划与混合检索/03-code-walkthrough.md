# M07 代码执行顺序详解

## 1. HTTP 到私密输入

1. `RetrievalDebugController.execute` 只解析 UUID 和可信 `UserContext`。
2. `M07RetrievalService.debug` 先检查 `SYSTEM_ADMIN/AUDITOR`；普通阅读者在查询 Run 前即拒绝。
3. `loadRunInput` 的 SQL 同时要求 `run.owner_user_id=userId`。
4. Repository 返回密文形状；`SensitiveTextProtectorPort.reveal` 才在应用内存中得到问题。
5. 用当前身份重新收窄空间，不能只相信 Run 创建时的旧权限。
6. 权限范围被做成 SHA-256，供缓存隔离。

## 2. route_query

1. 空输入和明确绕权请求进入 `REJECT`。
2. 完整问候进入 `CHAT`，短指代且无历史实体进入 `CLARIFY`，其余进入 `KNOWLEDGE`。
3. 提取金额、日期、版本、代码、姓名和地域。
4. 非知识路线直接结束，不调用 LLM、Embedding 或 Milvus。

## 3. build_plan 与 rewrite_query

1. FilterCompiler 只接收 Run Manifest、当前允许空间和 asOf。
2. Filter 字段/操作符来自枚举，并固定要求 Manifest 成员与版本匹配；没有表达式字符串字段。
3. 先以原问题创建安全计划，只有长问题、多跳或有历史指代才调用 LLM。
4. Adapter 输出只允许 `rewrittenQuery/subQuestions/entities`，最多四个子问题。
5. Zod 校验后检查原始字面量；缺失值以“精确条件”原样补回。
6. 当前问题包含某实体类别时，历史中同类实体失效。
7. 改写失败降级到确定性计划；父级取消必须继续抛出，不能吞掉取消。

## 4. query_embedding 与缓存

1. Key 包含 Embedding/Retrieval Profile、模型 revision、planHash、权限 scopeHash 和 queryHash。
2. Key 不含问题明文；权限或 Profile 任一变化都会 miss。
3. Redis 值通过 Zod，再比对 modelId、revision 和 Dense dimension；不兼容缓存当 miss。
4. 未命中项合成一个 `embedQueries` 批次，携带 Deadline、单次超时和 Run AbortSignal。
5. Provider 部分失败、漏项、模型/修订/维度不匹配都会阻断本轮。
6. Redis 写失败只记录降级，本次真实向量继续；PG 权限复核不会被跳过。

## 5. hybrid_retrieve 与 RRF

1. 为每个子问题、每个可见 Manifest 生成组合。
2. Dense 与 Sparse 两组 Promise 同时启动，由 `Promise.allSettled` 汇合。
3. 一路失败时丢弃该路并设置 degraded；两路都不可用才返回 503。
4. 每个子问题分摊路线权重，避免拆成四问后总权重放大四倍。
5. RRF 在每个列表内先按 vectorId 去重，再按公式累加；最终同分按 vectorId 排序。

## 6. source_recheck、二轮与 diversify

1. 候选和 Manifest 快照作为 JSON 参数一次传给 PostgreSQL。
2. `jsonb_to_recordset` 与 `chunk_embedding_refs.vector_id` 批量 JOIN，避免 N+1。
3. SQL 除了检查传入的允许空间，还会用当前 `user_id + roles` 查询 `resource_acl`，防止上层列表
   被错误放大；随后检查空间、Manifest 状态/版本/Profile、成员版本/revision、Chunk、文档、发布
   和生效窗口。
4. 任一条件失败即没有正文返回，只累计脱敏原因码。
5. 第一轮累计候选少于 minimumResults 时进入 `retry_plan`；第二轮不再调用 LLM。
6. `round=2` 后只能进入 `diversify`，不可能形成第三轮。
7. 多样性控制限制同文档、同 headingPath 数量。

## 7. 调试响应

响应包含 route、planHash、轮数、缓存/降级、路线摘要、候选排名/RRF 分和剔除统计；不包含问题、
displayContent、Embedding、Provider 原始响应或密钥。
