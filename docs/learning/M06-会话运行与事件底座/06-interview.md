# M06 面试追问与回答框架

## “为什么 PG 和 Redis 都存事件，不会双写不一致吗？”

PG Outbox 是待发布事实，Redis Stream 是短期投影，不是两个平级事实源。业务事务只提交 PG；Publisher 至少一次投递，Redis Lua 按 sequence 幂等。Redis 缺失可以从 PG Run 降级，完成通知永远晚于答案事务提交。

## “幂等为什么需要咨询锁，唯一索引不够吗？”

唯一索引能阻止两行，但后到请求可能在已插入消息后才冲突，或只能收到数据库错误。事务级咨询锁按 userId+key 串行化，后到者能稳定读取首个 Run；唯一索引继续防代码缺陷和异常路径。请求 Hash 用来拒绝同 key 不同请求。

## “为什么 sequence 不直接用 Redis XADD \*？”

sequence 是可审计的业务事件顺序，必须在 PG 事务中确定。若 Redis 自己分配，重投可能得到新 ID，PG 与客户端无法判断重复。固定 `${sequence}-0` 让 Last-Event-ID、Outbox 和 Stream 使用同一坐标系。

## “如何保证 answer.completed 之前答案可查？”

助手消息、Run COMPLETED 和完成 Outbox 在同一个 PG 事务。Publisher 只能查询已提交 Outbox，所以它不可能在答案不可见时把完成事件写入 Redis。集成测试直接 join 三张表验证相同 assistantMessageId。

## “取消和超时同时发生怎么办？”

行锁、optimisticVersion 和状态机决定唯一赢家。取消把状态变为 CANCELLING，超时可变 EXPIRED；一旦进入终态，任何晚到完成都被拒绝。AbortSignal 负责尽快节省下游资源，但正确性不依赖 Provider 一定立刻响应取消。

## “EventSource 怎么认证？”

支持认证 SSE 和一次性 Ticket 两条路。Ticket 经已认证 POST 签发，绑定 runId+userId，以 HttpOnly SameSite Cookie 发送，Redis 只保存 Hash，GET+DEL 原子兑换。它不出现在 URL/访问日志，也不是长期会话凭据。

## “Redis Stream 被清空怎么办？”

运行中短暂还未发布时等待；终态或超过事件保留期且 Stream 不存在时，响应 `streamExpired` 和 PG Run，前端转为状态轮询。最终答案仍在 PG。若需要恢复完整过程审计，应读 PG Step/Outbox 运维视图，而不是承诺 Redis 永久保存。

## “为什么摘要也要记录来源空间？”

摘要是历史知识的派生物。只对消息重鉴权却继续返回摘要，会通过侧信道泄漏已撤权内容。保存来源空间后，每次读取重新鉴权；任一来源不可见则摘要、实体和最近引用整体隐藏。

## “AES-GCM 解决了什么，没解决什么？”

它提供静态数据机密性和认证完整性，随机 IV 避免相同明文产生相同密文，Hash 支持重放/审计。它不替代数据库访问控制、TLS、密钥托管和日志脱敏。当前单 key 设计在正式密钥轮换前需扩展 key version。

## “M06 和 M07 的边界？”

M06 管执行容器、状态、事件、取消、会话和合规；M07 管查询改写、授权检索、融合、Rerank 和证据。M07 必须使用 M06 冻结 Manifest 和 AbortSignal，不能自己读当前 Head 或创建第二套 Run。
