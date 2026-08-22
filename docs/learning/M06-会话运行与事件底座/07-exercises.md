# M06 学习练习

## 基础练习

1. 画出 `POST /conversations/{id}/runs` 从 Guard 到 PG Commit 的调用链，并指出哪一层可以读取环境变量。
2. 给定 ACCEPTED、RUNNING、CANCELLING、COMPLETED 四个状态，解释每个状态允许的下一步和拒绝原因。
3. 手工计算一个 Run 五类事件的 sequence，并模拟客户端在收到 3 后断线如何续传。
4. 找出公共 Message 与 StoredMessage 的字段差异，解释为什么 Controller 永远不应看到 IV/AuthTag。

## 代码练习

1. 为 `saveConversationState` 增加一个“错误 expectedVersion 返回 VERSION_CONFLICT”的集成断言。
2. 为 Redis Adapter 增加 sequence gap 测试：先写 1，再写 3 应失败；重复写 1 应幂等。
3. 模拟 event stream `read` 抛错，证明 `listEvents` 仍返回 PG Run 且终态 `streamExpired=true`。
4. 在不添加高基数标签的前提下，为取消从请求到 AbortSignal 记录延迟 Histogram。

## 故障推演

分别回答以下时刻进程崩溃后会发生什么、由谁恢复：

- 用户消息已插入，Run 尚未插入（同一事务未提交）；
- 答案和 Outbox 已提交，Redis 尚未写；
- Redis 已 XADD，Publisher 尚未标记 published；
- 客户端收到答案事件，但 TCP 在写完前断开；
- 用户取消后 Provider 无视 AbortSignal 并返回答案；
- 管理员在 Run 执行期间发布了新 Manifest。

## 面试模拟

要求自己在 10 分钟内、不看代码回答：

1. 如何证明没有重复答案？
2. 为什么断线续传不会乱序？
3. 如何避免 Ticket 出现在日志？
4. 撤权后为什么连摘要也要隐藏？
5. Redis 完全丢失时，系统还能向用户保证什么，不能保证什么？

能把答案落到具体表、约束、事务、状态迁移和测试名称，才算真正掌握，而不是只会背“用了 Outbox”。
