# M06 Run、事件与 SSE 运维手册

## 部署前配置

内网至少显式确认以下配置：

- `RUN_*_VERSION/PROFILE_ID`：行为改变时换版本，旧 Run 不受影响。
- `RUN_DEADLINE_SECONDS`：覆盖检索、Rerank 和 LLM 总时间，不等于单次 Provider timeout。
- `RUN_EVENT_RETENTION_SECONDS`：应大于前端最大重连窗口。
- `RUN_EVENT_STREAM_MAX_LENGTH`：中型规模默认 10000；需结合单 Run 最大 token/event 评估。
- `RUN_STREAM_TICKET_TTL_SECONDS`：默认 60 秒，只用于建立连接。
- `RUN_CONTENT_STORAGE=AES_256_GCM`。
- `RUN_CONTENT_ENCRYPTION_KEY`：由 Secret 注入 Base64 32 字节随机值；生产会拒绝仓库测试密钥。
- `RUN_CONTENT_RETENTION_DAYS`：由企业合规确认，不应由开发者自行猜测。

Query Service 需要同时访问 PostgreSQL 与 `REDIS_CACHE_URL`。Redis Stream 不是 BullMQ Redis，当前使用缓存 Redis DB；容量和持久化策略需单独核算。

## 前端标准流程

1. `POST /api/v1/conversations` 创建或恢复会话。
2. 为一次逻辑提问生成稳定 Idempotency-Key。
3. `POST /api/v1/conversations/{id}/runs`，收到 202 后保存 runId/eventsUrl。
4. 能携带认证时连接 `/runs/{id}/events`；原生 EventSource 先 POST `/stream-ticket`，再连接返回 streamUrl。
5. 持久化最后成功事件 ID；断开后用 `Last-Event-ID` 重连。
6. 收到 `stream.expired` 或轮询结果 `streamExpired=true`，改用 `/runs/{id}` 查询终态。
7. 用户停止时调用 `/runs/{id}/cancel`，界面显示“正在取消”，直到 CANCELLED/EXPIRED 等终态。

## 关键指标

- `m06_run_operations_total{operation,result}`：事件发布、取消、Deadline 和清理结果。
- `m06_sse_connections{transport}`：认证/Ticket 当前连接数。
- `m06_event_publish_lag_seconds`：PG Outbox 到 Redis 的投递延迟。

建议告警基线需经压测确认：Publisher 连续失败、P95 延迟超过前端可感知阈值、Outbox 未发布数量持续增长、SSE 连接数接近网关/文件描述符限制。

## 数据库排障查询原则

运维查询只使用 runId、状态、sequence、时间、稳定错误码和 Hash。不要 SELECT/打印 `content_value`、IV、Tag、Ticket、完整问题或引用证据。

检查顺序：`rag_runs` → `rag_run_steps` → `rag_run_event_outbox`。若答案完成，`assistant_message_id` 与 `answer.completed.payload.assistantMessageId` 必须一致。

## Redis 恢复

不要只删除 last-sequence Key 或只删除 Stream。需要重建时，两者作为一组处理，然后让 PG Outbox 从 sequence 1 重新投影；已标记 published 的事件需要受控运维工具重置，不能在生产手工全表 UPDATE。当前仓库未提供破坏性重放 API，避免普通管理员误操作。

## 内网验收

- 至少两个 Query Service 副本验证跨实例取消。
- Nginx/Ingress 关闭 SSE 缓冲并把 idle timeout 设为大于 heartbeat。
- Redis 重启、主从切换与网络分区时验证 PG 降级和恢复投递。
- 使用批准脱敏数据做并发幂等、断线续传、慢客户端和 8 小时 soak。
- 验证日志、APM、WAF 和访问日志均不包含 Ticket、正文、预签名 URL 或敏感证据。
