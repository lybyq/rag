# M06 调试与故障定位

## Run 一直停在 ACCEPTED

按顺序检查：

1. PG `rag_runs.status/deadline_at` 是否正常；M06 本身不执行模型，M07 Worker 未接入时停在 ACCEPTED 是预期。
2. `rag_run_event_outbox` 是否有 `run.accepted`，`published_at` 是否为空。
3. Query Service 的 `m06_run_operations_total{operation="event_publish"}` 是否有 failure。
4. Redis `rag:run:{id}:events` 是否存在。不要把完整问题粘贴到日志或 Redis CLI 截图。

## SSE 连接成功但没有事件

- 确认代理关闭缓冲；响应应有 `X-Accel-Buffering: no`。
- 查看 Last-Event-ID 是否大于服务端最后 sequence。
- 终态且 `streamExpired=true` 时前端应改轮询 `/runs/{id}`，不是无限重连。
- 原生 EventSource 不能方便设置 Authorization Header 时，使用 stream-ticket Cookie 路径。

## Ticket 第一次就 404

- Ticket 是否超过 10～300 秒配置 TTL。
- 浏览器是否把 Cookie 发到精确 Path `/api/v1/run-streams/{runId}`。
- runId 是否与签发时绑定的一致。
- Ticket 是一次性的：开发工具预请求、两个标签页或重试中间件都可能先消费它。

严禁把 Ticket 放到 URL 排查；URL 会进入访问日志。

## Redis 报 RUN_EVENT_SEQUENCE_GAP

先查同 Run Outbox：是否有更小 sequence 未发布、被长期锁住或 available_at 尚未到。Publisher 查询保证只领最早事件，若人工直接删除 Outbox 或 Redis sequence Key/Stream 只删其一，就可能制造缺口。修复时以 PG Outbox 为事实重建整个该 Run Stream，不要伪造缺失事件。

## Run 完成返回 VERSION_CONFLICT

查询 `status` 和 `optimistic_version`：

- CANCELLING：用户取消已获胜，晚到答案必须丢弃。
- EXPIRED：Deadline 维护已获胜，Provider 返回也不能复活 Run。
- COMPLETED 且 answer Hash 相同：这是合法重放，应返回原事实。
- COMPLETED 但 Hash 不同：两个执行器产生不同答案，必须告警和排查重复领取。

## 摘要解密为 null

可能是摘要来源撤权、AES Key 不一致、密文/Tag/Hash 被修改或保留策略清理。检查 storage 和稳定错误，不打印密文、IV、Tag 或原文。生产轮换密钥前必须设计 key version 与重加密流程；当前版本只有单 key，不能直接覆盖旧 key。

## Redis 故障的行为

PG 创建和完成仍可提交；事件留在 Outbox。认证轮询返回 PG Run 降级事实。Redis 恢复并重启/恢复 Query Service 后 Publisher 继续投递。Readiness 应在 Redis 不可用时摘除实例，不能把缓存故障变成授权放行。
