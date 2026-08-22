# ADR-013：M06 PostgreSQL Run 事实与 Redis 事件投影

- 状态：Accepted
- 日期：2026-08-23
- 关联需求：RUN-001～RUN-014

## 背景

问答请求比普通 HTTP 请求长：浏览器可能刷新、网关可能断开、模型可能超时、用户可能取消，服务也可能在生成答案后、通知浏览器前崩溃。如果只把状态放在进程内存或只依赖一条 SSE 连接，就无法判断一次提问是否已经完成，也无法安全重放。

Redis Stream 适合短期顺序事件和断线补发，但不是最终业务事实源：Key 有 TTL，Redis 可能重启或被淘汰。PostgreSQL 适合事务和审计，但让 SSE 每 500 ms 扫描整张事件表会增加在线数据库压力。

## 决策

1. PostgreSQL 保存 Conversation、Message、ConversationState、RagRun、RagRunStep 和反馈；`rag_runs` 是最终状态事实。
2. 创建 Run 的用户消息、Run、冻结快照和首个 `run.accepted` Outbox 在一个事务提交。`Idempotency-Key` 以 `owner_user_id` 为作用域，并发请求先取得事务级咨询锁，再由数据库唯一约束兜底。
3. 每个 Run 在 PG 行内分配 `next_event_sequence`。事件先进入 `rag_run_event_outbox`，Publisher 只领取每个 Run 最早的未发布事件。
4. Redis Stream ID 固定为 `${sequence}-0`；Lua 同时维护最后序号，重复投递幂等，序号跳跃 fail-closed。Stream 和序号 Key 使用相同 TTL。
5. SSE 支持正常认证和一次性 Ticket。Ticket 绑定 `runId + userId`，Redis 只存 Ticket 的 SHA-256，兑换使用 GET+DEL；浏览器路径优先使用 HttpOnly、SameSite Cookie，凭据不进入 URL。
6. `Last-Event-ID` 就是 sequence。慢客户端在写缓冲 30 秒仍未 drain 时断开；客户端携带最后成功 ID 重连。终态 Stream 丢失或到期时返回 PG Run 和轮询 URL。
7. 最终答案消息、Run `COMPLETED` 和 `answer.completed` Outbox 在同一 PG 事务；Publisher 只能在事务提交后看到事件，所以完成通知不可能先于答案事实。
8. 取消先把 Run 改为 `CANCELLING` 并写 Outbox，再中止本实例 AbortController；事件发布到 Redis 后广播给其他实例。执行器捕获取消后确认 `CANCELLED`。
9. Run 创建时冻结 flow、policy、prompt、validator、Embedding、Reranker、LLM、授权版本和每个空间的 Manifest。灰度 Manifest 按 userId 稳定分桶后冻结，后续发布不会改变在途 Run。
10. 问题、答案和摘要按配置使用 AES-256-GCM、REDACTED 或仅开发可用的 PLAIN。生产拒绝 PLAIN 和默认测试密钥；保留期到期覆盖正文与引用，但保留 Hash、状态、时间和反馈审计。
11. 会话只保存有限短窗口、摘要、确认实体和最近引用。摘要写入带乐观锁并记录来源空间；读取时重新鉴权，任一来源撤权则摘要、实体、引用整体隐藏。

## 为什么不用其他方案

- 只用 WebSocket/SSE 内存状态：连接断开或实例重启就丢事实，也无法幂等回答。
- 只用 Redis：TTL 与故障恢复语义不适合最终答案和合规审计。
- 所有 SSE 都携带长效 JWT 查询参数：URL 会进入代理访问日志、浏览器历史和监控系统。
- 先发 `answer.completed` 再写答案：崩溃窗口会让前端收到一个数据库中不存在的结果。
- 取消时直接写 `CANCELLED`：下游可能尚未真正停止；`CANCELLING` 明确表达“取消请求已接受，等待执行器收口”。
- 会话保存完整上下文：成本、泄漏面和撤权处理都会随轮数无限增长。

## 结果与代价

问答运行可以重放、续传、审计和降级，Redis 丢失不影响最终 Run/答案。代价是多一个事件 Outbox 发布器、两套存储的一致性监控，以及 Graph 执行器必须严格携带 `expectedVersion` 和 `AbortSignal`。

M06 只提供执行容器，不伪造检索或模型答案。M07/M08 接入真实检索与生成时必须复用本 ADR 的生命周期服务，不能另建第二套 Run 状态。
