# M02 文档接入与任务中心：实施与验收证据

> 日期：2026-08-16。本文区分“代码/契约完成”“真实 PostgreSQL/Redis 验证”和“受本机 Registry 网络限制尚未执行的真实 MinIO 验证”。

## 1. 需求映射

| 需求    | 主要实现                                                   | 自动化/验收证据                              |
| ------- | ---------------------------------------------------------- | -------------------------------------------- |
| DOC-001 | `document-ingestion.ts` + M02 migration                    | Zod strict typecheck、migration gate         |
| DOC-002 | `ingestion-state-machine.ts`、`optimistic_version`、行锁   | 状态机单测、重处理集成测试基础               |
| DOC-003 | UploadsController、DocumentIngestionService、MinIO Adapter | API build、MinIO 契约测试                    |
| DOC-004 | AppConfig upload 限额、Zod max(100)                        | 200 MiB 应用单测、配置测试                   |
| DOC-005 | Multipart Port/Adapter、`useDocumentUpload`                | part 签名契约、Vue typecheck/build、视觉验收 |
| DOC-006 | `headObject` + `assertStoredObject`                        | metadata 契约测试、大小不匹配单测            |
| DOC-007 | `sanitizeOriginalFileName`、`createIsolatedObjectKey`      | 恶意路径/控制字符单测                        |
| DOC-008 | `PostgresDocumentIngestionRepository.completeUpload`       | 真实 PG 回滚、重试和重复 Complete 集成测试   |
| DOC-009 | Outbox CTE SKIP LOCKED、BullMQ eventId、Inbox              | 双 Publisher、重复 Consumer 集成测试         |
| DOC-010 | `createIngestionJobId/createIngestionStepId`               | ID 语义单测，10 个稳定 Step                  |
| DOC-011 | documents/versions/jobs/controllers                        | OpenAPI current gate、API 200 smoke          |
| DOC-012 | execution status schema + step 时间字段                    | Schema/DB CHECK、任务映射集成测试            |
| DOC-013 | heartbeat + processed/total/stage/overall/message          | 真实 PG heartbeat 集成测试                   |
| DOC-014 | `calculateStagePercent/calculateOverallPercent`            | 未知总量与权重单测、UI indeterminate         |
| DOC-015 | JobEvent bigserial、SSE、ETag poll                         | OpenAPI、浏览器无运行时错误、PG 事件集成测试 |
| DOC-016 | acquire lease、owner heartbeat、scheduler recovery         | Worker B 拒绝、过期重排队集成测试            |
| DOC-017 | reprocess contentRevision + 新稳定 Job                     | PG 事务实现、旧 Job 唯一键保留               |
| DOC-018 | 用户审计 Port + Worker/Scheduler system audit              | SQL 与既有敏感字段清理 Adapter               |

M02 另暴露低基数 `rag_m02_operations_total{operation,result}` 指标，覆盖上传会话创建/完成/取消、版本重处理、任务取消、队列去重消费、Outbox 发布和租约恢复；用户、文档和任务 ID 不进入标签。

## 2. 关键不变量

### 文件字节不经过 API

- HTTP 创建会话契约只有 `clientFileId/originalFileName/sizeBytes/contentType/sha256?`。
- Controller 没有文件流或 multipart body 参数。
- Vue 的 Blob 只进入 `putPresignedObject(url, blob)`；该 URL 来自 MinIO 签名。
- 200 MiB 单测只向服务端发送数值元数据，并验证生成 25 个 8 MiB 分片。

### 完成事务与幂等

真实 PostgreSQL 测试先用非法 Hash 触发 CHECK 失败，随后断言空间内 `documents=0`。合法重试成功后重复 Complete，结果仍是：

```text
documents=1
jobs=1
outbox=1
steps=10
```

Multipart “对象合并成功、PG 失败”路径通过 HEAD-first 单测，重试不会再次调用失效的 multipart uploadId。

### Outbox、Consumer 与 Worker 重启

- Publisher A 领取后，Publisher B 在 lease 窗口领取 0 条。
- 同一 eventId 第一次 Inbox 处理返回 true，第二次返回 false。
- BullMQ 使用 `jobId=outboxEventId` 作为传输层去重。
- Worker 领取使用 lease owner；其他 Worker heartbeat 返回 undefined。
- 5/10 个安全扫描单位得到 `stagePercent=50`、`overallPercent=4`。
- lease 人工过期后 Scheduler 恢复为 `QUEUED/attempt=2`。

## 3. Web 验收

使用本地 Platform API 与 Vue 开发服务检查 `/tasks`：

- 当前 Mock 身份和可写空间正确加载；
- 上传 Dropzone、空间选择、空队列、禁用提交、任务空状态均可见；
- 桌面布局与 390×844 移动布局无横向结构破坏；
- 浏览器 console error/warning 为 0；
- UI 文案明确“字节不经过 API”、HEAD、事务 Outbox 与可恢复进度；
- 未知步骤总量使用 Element Plus indeterminate，不显示伪造数字。

## 4. 已执行门禁

```text
ingestion-core unit: 6 passed
application M02 unit: 4 passed
MinIO adapter contract: 3 passed
M02 PostgreSQL integration: 3 passed
M02 BullMQ/Redis integration: 1 passed
TypeScript strict: passed
ESLint max warnings 0: passed
Vue production build: passed
4 backend builds: passed
OpenAPI current: passed
migration checksum/order: passed
```

最终全量 `pnpm check` 已通过；生产依赖 `pnpm security:audit` 返回 `No known vulnerabilities found`。

## 5. 环境限制与未虚构证据

本机成功运行 PostgreSQL、Redis Cache 和独立 BullMQ Redis。固定 digest 的 MinIO 镜像拉取两次均在 Docker Hub token/manifest 请求阶段超时，因此本轮没有宣称完成真实 MinIO 端到端验收。

已经完成的是 MinIO Adapter 契约测试（签名参数、HEAD metadata、错误、取消）和浏览器/服务端编译。真实 MinIO 的 CORS、ETag 暴露、单 PUT、Multipart 合并和 abort 必须在 Registry 可达的 CI/开发机补跑；运行步骤见本地 Runbook。
