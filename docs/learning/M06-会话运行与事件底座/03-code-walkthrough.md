# M06 代码走读：按一次提问的执行顺序理解

本章不对 import、括号和简单赋值写重复注释，而是按真实执行路径逐段解释每一类语句为什么存在。建议在 IDE 中按下面顺序打开文件并逐行对照。

## 1. 从运行时契约开始

打开 `libs/contracts/src/rag-run.ts`：

1. 文件顶部 Timestamp 和 SHA-256 Schema 统一所有实体的基础约束。
2. Conversation/Message/State Schema 决定 HTTP、PG 映射和 OpenAPI 共同形状；公共对象故意没有 `ownerUserId`、密文 IV 或认证标签。
3. `RagRunStatusSchema` 列出全部状态，避免数据库、前端和 Worker 各写一套字符串。
4. `RunManifestSnapshotSchema` 保存每个空间真正查询的 Manifest/Collection 和授权策略版本；客户端不能提交 Collection。
5. `RagRunSnapshotSchema` 冻结流程和所有 Provider revision。以后修改默认配置不会修改旧 Run。
6. Request Schema 限制问题长度、空间数量、取消原因和反馈，Controller 对未知输入执行 `safeParse`。
7. Envelope Schema 让 OpenAPI 与真实响应保持一致。

再打开 `libs/domain/src/rag-run-state.ts`：允许迁移表是状态机真相。`assert...` 只处理纯业务规则，不读数据库；Repository 在持有行锁后调用它，避免检查后状态又变化。

## 2. 看端口，而不是先看 SQL

打开 `libs/application/src/rag-run.ports.ts`：

- `ProtectedSensitiveText` 是内部形状，明确区分 storage、密文、IV、Tag 和 Hash。
- `CreateRagRunCommand` 已经包含可信 owner、保护后的问题、冻结快照和三种 Deadline；Repository 不再自行猜配置。
- `RagRunRepository` 区分面向用户的 `AccessContext` 与面向可信 Worker 的 `ownerUserId`。后者只能来自已持久化任务，不来自 HTTP body。
- `RagRunEventStreamPort` 只表达 append/read/ticket，不泄露 XADD、Lua 或 Redis Key。
- `RagRunCancellationPort` 返回标准 AbortSignal，后续 HTTP Provider 可以原样接收。

## 3. Controller 只做边界映射

依次打开 `conversations.controller.ts`、`runs.controller.ts` 和 `m06-http-utils.ts`：

1. `@CurrentUser()` 的身份来自 M01 Guard，不读取 body 中的 userId/roles。
2. `parseM06Input` 把 Zod 错误变成稳定 400，避免未知异常被全局 Filter 当成 500。
3. 创建 Run 单独读取 `Idempotency-Key`；没有它不会退化成非幂等接口。
4. Controller 只调用 Use Case，再套 requestId/traceId Envelope；没有 SQL、Redis Key 或模型配置。
5. SSE 在完成鉴权/Ticket 兑换后才写响应 Header，失败请求不会先返回 200。
6. `writeSse` 在 `response.write=false` 时等待 drain；超时或请求关闭就结束连接。
7. 循环中的 cursor 只在写成功后前移，所以客户端断开后不会跳过未真正写出的事件。

## 4. 创建 Run 的 Application 逻辑

打开 `libs/application/src/rag-run.service.ts` 的 `createRun`：

1. 规范化 key，并先验证会话所有权。
2. 对 requested space 去重排序，再调用 AuthorizationService；权限只允许缩小，绝不相信客户端声称的空间。
3. 读取发布路由。缺少 ACTIVE Manifest 就 409，避免 M07 查询一个不存在的索引。
4. 若有 CANARY，使用 userId 做确定性分桶；选择结果写入快照，不在每个节点重新抽签。
5. roles 只保存 SHA-256，不把完整角色列表复制进每个 Run。
6. 计算请求 Hash。它包含会话、问题和排序后的空间，用于区分“合法重放”和“同键不同请求”。
7. 正文先经 Protector，再交给 Repository 原子创建。

`listMessages` 先读取密文短窗口，再对每条助手消息的 `spaceIds` 和摘要来源空间重新鉴权。权限不足时返回 REDACTED/null，不尝试返回部分敏感摘要。

## 5. PostgreSQL 事务细节

打开 `libs/persistence-pg/src/postgres-rag-run.repository.ts`：

- `createRun` 的咨询锁只序列化同用户同 key；不同问题不会互相阻塞。唯一约束仍是最终一致性边界。
- 用户消息在幂等检查后插入。Run 创建后回填 message.run_id，并更新短窗口和会话时间。
- `appendEvent` 通过 `UPDATE rag_runs ... RETURNING next_event_sequence` 在行锁内分配序号，再插 Outbox；同 Run 不会拿到重复 sequence。
- `startRun/completeRun/failRun/finalizeCancellation` 都比较 optimisticVersion，并调用 Domain 状态机。
- `completeRun` 在一个事务中插助手消息、更新 Run、追加短窗口、更新会话和写 `answer.completed`。
- `claimEventOutbox` 的 `NOT EXISTS earlier` 保证每个 Run 只领取最早未发布事件，`SKIP LOCKED` 让多个 Publisher 横向扩展。
- `updateConversationState` 同时检查 owner 和 expectedVersion；密文 Hash 与来源空间一起更新。
- 清理正文只覆盖 value/IV/Tag/citations，不删除 Hash 和审计关系。

## 6. Redis Lua 与一次性 Ticket

打开 `libs/persistence-redis/src/redis-rag-run-event-stream.adapter.ts`：

1. Lua 读取最后 sequence；小于等于当前值表示 Outbox 重投，直接返回 DUPLICATE。
2. 大于当前值但不是 `current + 1` 表示发布乱序，返回错误，让 Publisher 释放租约重试。
3. XADD 使用 `${sequence}-0`，随后同时设置 Stream/sequence Key TTL 并近似裁剪长度。
4. Ticket 用 32 字节随机数生成，Redis Key 只含 SHA-256；NX 防极小概率碰撞。
5. 兑换 Lua 先 GET 再 DEL，是单条原子操作；两台实例同时兑换最多一台成功。
6. cancel event 成功进入 Stream 后再 PUBLISH，只广播 runId，不广播问题或取消原因全文。

## 7. Scheduler 与可观测性

`run-event.scheduler.ts` 每 200 ms 尝试发布，不允许同实例重入；维护任务按配置周期执行。每条成功投递记录 PG→Redis 延迟 Histogram，操作计数区分 success/failure，SSE Gauge 区分认证流和 Ticket 流。标签里没有 userId/runId，避免高基数拖垮 Prometheus。

## 8. 迁移阅读顺序

1. `20260823100000_m06_conversations_and_runs.sql`：核心表、外键、唯一约束和索引。
2. `20260823110000_m06_conversation_state_version_and_sources.sql`：已部署数据库前滚增加状态版本和摘要来源。
3. `20260823120000_m06_conversation_summary_hash.sql`：摘要密文完整性 Hash 与形状约束。
4. `20260823130000_m06_conversation_summary_retention.sql`：把敏感派生摘要纳入保留期清理。

增量迁移没有回头修改第一条已执行迁移，这正是生产数据库演进的基本纪律。
