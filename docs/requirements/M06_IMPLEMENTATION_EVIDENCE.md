# M06 会话、Run 与事件底座：实施证据

> 日期：2026-08-23。本文区分外网本地已执行的代码/真实 PostgreSQL+Redis 证据，以及必须带入内网后补跑的多实例和基础设施证据。

## 需求映射

| 需求    | 主要实现                                               | 自动化证据                                           |
| ------- | ------------------------------------------------------ | ---------------------------------------------------- |
| RUN-001 | M06 四条前滚 migration、`rag-run.ts`                   | Contract、Migration、真库 CRUD                       |
| RUN-002 | PG 咨询锁、请求 Hash、唯一约束                         | 8 并发同键只有一份 Run/消息；异请求 409              |
| RUN-003 | `RagRunService.createRun`、202 Controller              | 响应包含 ACCEPTED/events/ticket/expiry，不调用模型   |
| RUN-004 | `RagRunSnapshot`、M05 路由解析                         | 真库断言 Manifest 与全部 Profile/revision/authz 冻结 |
| RUN-005 | Domain 状态机、乐观锁、Maintenance                     | 终态/竞态单测，真库 Deadline → EXPIRED               |
| RUN-006 | `rag_run_steps`、Lifecycle                             | 真库节点摘要、耗时、错误、Trace 与顺序事件           |
| RUN-007 | PG sequence Outbox、Redis Lua Stream                   | 真 Redis 严格 1～5、TTL/长度配置，发布失败单测       |
| RUN-008 | 认证 SSE、Hash Ticket + GETDEL                         | 真 Redis Ticket 只成功兑换一次                       |
| RUN-009 | Last-Event-ID、heartbeat、drain、ETag/PG fallback      | Controller 逻辑、真 Stream 游标与终态降级            |
| RUN-010 | CANCELLING、AbortSignal、Redis cancel channel          | Signal 单测、真库取消/终态/越权测试                  |
| RUN-011 | answer+Run+Outbox 同事务                               | 真库 join 相同 assistantMessageId；不同晚到答案 409  |
| RUN-012 | 短窗口、加密摘要、实体/引用、来源空间重鉴权            | 真库摘要乐观锁；模拟撤权后消息/摘要整体脱敏          |
| RUN-013 | Conversation/Run/Step/Event/Cancel/Ticket/Feedback API | Zod 契约与 Query OpenAPI 3.1                         |
| RUN-014 | AES-GCM/REDACTED/PLAIN、生产配置门禁、清理             | 随机 IV/篡改单测；真库不含原文且到期保留 Hash        |

## 核心一致性证据

- Idempotency-Key 的作用域是 userId；并发锁只影响同键请求，不串行化所有用户。
- sequence 由 PG Run 行在事务中分配，Redis 不自行生成第二套顺序。
- Publisher 每个 Run 只领取最早未发布事件；Redis Lua 拒绝 gap 并幂等忽略重复。
- 答案消息、Run COMPLETED 和完成 Outbox 原子提交；完成事件无法早于答案。
- Ticket 不进 URL，Redis 只保存 Hash，兑换后原子删除。
- 终态不可逆；AbortSignal 用于节省下游资源，状态机/乐观锁负责正确性。
- 摘要密文保存 SHA-256 并记录来源空间；撤权后不通过摘要泄漏历史知识。

## 已执行门禁

```text
Backend unit: 45 suites / 194 tests / 19 snapshots passed
Web console: 5 files / 7 tests passed
M01～M06 PostgreSQL/Redis integration: 19 passed
M06 PostgreSQL + Redis integration: 4 passed
Runtime smoke: compiled rag-query-service started; health/live=up; authenticated Conversation create=201
Format / ESLint / strict TypeScript+Vue / dependency boundary: passed
Backend + web production build: passed
OpenAPI: 2 generated documents current
Migration: 13 files applied/checked
Docker Compose static checks: external / apps / intranet passed
Offline dependency audit: passed in non-strict mode
```

全量集成命令另有 1 个既有 `infra-health` 环境探针失败：本机 MinIO 与 Milvus 未启动；PostgreSQL 和两套 Redis 为 up。由于系统 C 盘已满，没有为制造绿色结果继续拉取重型镜像。M06 自身的真实 PG+Redis 集成与运行时烟测均通过；MinIO/Milvus 环境缺口已在 M05/内网验收中保留。

## 内外网边界

M06 不依赖 LLM/Embedding/Reranker/Milvus 的实际响应，因此外网可以完整验证运行底座。M07/M08 接入内网 Provider 时，只从冻结 Run 快照取得版本和 Manifest，并把 Lifecycle 返回的同一 AbortSignal 传给所有远程 Port。

内网仍需补跑：

- 两个以上 Query Service 副本的 Redis Pub/Sub 跨实例取消；
- 企业 Redis 主从/集群切换、Stream TTL、内存淘汰与恢复；
- 企业 Ingress 的 SSE buffering、heartbeat、idle timeout、最大连接数；
- Secret 托管、备份恢复、密钥轮换方案和正文保留期审批；
- 中型规模并发创建、慢客户端、断网重连和至少 8 小时 soak。

这些是环境验收项，不以本地单实例结果冒充完成。
