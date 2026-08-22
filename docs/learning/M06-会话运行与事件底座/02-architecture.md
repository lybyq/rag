# M06 架构：PG 事实、Redis 投影和 SSE 适配

## 依赖方向

```text
HTTP Controller / Scheduler
        │
        ▼
RagRunService / RagRunLifecycleService / Publisher / Maintenance
        │
        ├── RagRunRepository ───────────────► PostgreSQL Adapter
        ├── RagRunEventStreamPort ──────────► Redis Stream Adapter
        ├── RagRunCancellationPort ─────────► Redis + AbortController Adapter
        ├── SensitiveTextProtectorPort ─────► AES-GCM Adapter
        └── AuthorizationService ───────────► M01 ACL + Redis Cache + PG
```

Domain 只知道状态迁移，不依赖 NestJS、PG、Redis 或模型 SDK。Composition Root 位于 `apps/rag-query-service/src/m06/m06.module.ts`，这里是唯一可以选择具体 Adapter 和读取配置的地方。

## 创建 Run 链路

```text
POST conversation/runs
  → Auth Guard 构造可信 UserContext
  → Zod 校验 body/path/header
  → 确认会话属于当前 userId
  → M01 授权缩小 requestedSpaceIds
  → 读取 ACTIVE Head/CANARY，按 userId 稳定选择
  → 冻结模型、流程、Manifest、authz 快照
  → AES-GCM 保护问题
  → PG 事务：消息 + Run + run.accepted Outbox
  → 202 ACCEPTED
```

M06 不同步调用 LLM。后续 M07 Worker 领取 Run，再通过 `RagRunLifecycleService.start` 进入 RUNNING。

## 完成与通知链路

```text
Graph 得到答案
  → complete(expectedVersion)
  → PG 事务：助手消息 + Run COMPLETED + answer.completed Outbox
  → Publisher 按 sequence 领取
  → Redis Lua XADD sequence-0 + TTL + XTRIM
  → SSE 按 Last-Event-ID 补发
```

“先提交答案、后通知”不是时序约定，而是数据库事务与 Outbox 查询可见性保证。

## 取消链路

```text
POST /runs/{id}/cancel
  → PG: CANCELLING + run.cancel_requested Outbox
  → 本实例 AbortController.abort()
  → Publisher 写 Redis 并 PUBLISH cancel channel
  → 其他实例 AbortController.abort()
  → Graph 把同一 AbortSignal 传入检索/Reranker/LLM
  → 捕获取消并 finalizeCancellation(expectedVersion)
```

若完成回调晚到，状态机拒绝 `CANCELLING → COMPLETED`，因此不会覆盖用户取消事实。

## SSE 的两种认证

- 已认证 SSE：客户端能发送正常认证 Header/Cookie，直接访问 `/runs/{runId}/events`。
- Ticket SSE：先经认证 POST 签发一次性 Ticket，再由浏览器原生 EventSource 使用 HttpOnly Cookie 访问 `/run-streams/{runId}`。

Ticket 明文不写 Redis Key、不进 URL。Redis 仅保存 SHA-256 后的 Key 和 `runId + userId` 绑定，兑换后立即删除。

## 故障降级

- Redis Stream 过期或终态事件丢失：返回 `streamExpired=true` 和 PG Run，前端切换 Run 轮询。
- Publisher 单条失败：释放该 Outbox 租约并有限退避，继续处理其他 Run。
- 客户端过慢：等待 drain 30 秒后断开，保留最后成功 sequence，重连补发。
- 进程崩溃：PG Outbox 租约到期后由其他实例重新领取。
