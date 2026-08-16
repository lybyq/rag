# M02 代码走读：从按钮到 Outbox

## 1. 建议阅读顺序

1. `libs/contracts/src/document-ingestion.ts`：先看系统承诺了哪些事实。
2. `libs/ingestion-core/src/`：看状态机、进度、稳定 ID 和净化规则。
3. `libs/application/src/ingestion.ports.ts`：看业务需要哪些外部能力。
4. `libs/application/src/document-ingestion.service.ts`：看用例编排和故障窗口。
5. `database/migrations/20260816130000_m02_document_ingestion.sql`：看约束如何落到事实源。
6. `libs/persistence-pg/src/postgres-document-ingestion.repository.ts`：看事务、锁和幂等。
7. MinIO、BullMQ Adapter 和三个 Nest Composition Root。
8. Vue Composable 与组件。

## 2. 契约层

`DocumentVersionStatusSchema` 与 `IngestionExecutionStatusSchema` 故意分开。名字相似，但前者描述内容版本，后者描述一次异步执行。后续一个内容版本可以有多个 revision Job。

`IngestionJobStepSchema` 的关键字段：

- `processedUnits/totalUnits`：真实工作单位；
- `stagePercent`：总量未知时为 null；
- `overallPercent`：服务端权重算法的结果；
- `startedAt/heartbeatAt/finishedAt`：定位排队、卡住和实际耗时。

## 3. 领域层

`ingestion-state-machine.ts` 使用允许列表，不使用“只要不是终态就能跳”的宽松判断。相同状态允许返回，服务幂等重放。

`ingestion-progress.ts` 将步骤权重固定为 100。例子：安全扫描权重 8%，完成一半时总体只贡献 4%。未知总量贡献 0，不代表没工作，只代表不能给出可信比例。

`ingestion-identity.ts` 把影响任务语义的版本全部写入 ID。面试时可以强调：稳定 ID 不是为了美观，而是跨队列和重启的幂等键。

## 4. 应用层 createUploadSession

核心次序：

```text
鉴权 → 配额 → UUID/隔离 Key → 初始化 Multipart/签名单 PUT
→ 保存会话 → 审计 → 返回 URL
```

如果数据库保存失败，已经初始化的 Multipart 会执行补偿 abort。单 PUT 此时还没有对象，所以不需要删除。

所有对象存储调用携带 `AbortSignal.timeout`。这不是说 MinIO SDK 底层 socket 一定立刻中止，而是保证应用等待边界不会无限延长；SDK 自身仍需网络 timeout。

## 5. 应用层 completeUpload

先调用 `getCompletedUploadResult`，让已经提交成功的重复请求直接返回原结果。

Multipart 的 `tryHead → complete → retryHead` 收敛不确定结果。随后统一执行：

```ts
assertStoredObject(file, object, request.sha256);
repository.completeUpload(context, command);
```

注意 Hash 是“可用时核对”。普通 S3 Multipart ETag 不是 SHA-256，不能把它冒充内容 Hash。M03 会通过安全读取流计算可信 SHA-256。

## 6. PostgreSQL completeUpload

`FOR UPDATE OF us, uf` 阻止两个 Complete 同时创建两套事实。锁内再次检查 `file_status`：如果另一个请求已经完成，则读取既有引用。

数据库不仅靠代码：

- `upload_files.object_key UNIQUE`；
- `document_files.document_version_id UNIQUE`；
- `ingestion_jobs(document_version_id, content_revision, pipeline_version) UNIQUE`；
- `outbox_events(aggregate_id, event_type) UNIQUE`。

这叫 application idempotency + database idempotency 双层防护。

## 7. Outbox 与 Consumer

Scheduler 的 `OutboxPublisherService.publishOnce`：

1. 领取有限批次；
2. 每条调用 Publisher；
3. 成功才 `markOutboxPublished`；
4. 失败释放锁并延迟重试，不阻塞同批其他事件。

Consumer 的 `consumeQueuedIngestion` 把 Inbox 收据和状态副作用放在同一事务。M02 还没有 M03 安全处理器，所以明确进入 `WAITING`，而不是假装解析成功。

## 8. Lease 与 Heartbeat

`acquireJobLease` 只更新 `QUEUED` 行。`heartbeatJob` 同时校验：

- Job 是 RUNNING；
- leaseOwner 相同；
- lease 尚未过期；
- stepName 仍是 currentStep；
- Step 自身仍是 RUNNING。

然后调用领域进度算法，更新 Step 与 Job 并续租。旧 Worker 即使“复活”也不能覆盖新 Worker。

## 9. Vue 上传链

`useDocumentUpload` 保存唯一的副作用状态：File、AbortController、part 进度与会话。组件只接 props 和 emit。

`putPresignedObject` 使用 XHR，是因为标准 Fetch 上传目前不能稳定提供浏览器上传进度事件。XHR 只对预签名 URL 发送 Blob；Platform API 请求仍由统一 JSON Adapter 处理。

`useIngestionJobs` 每 3 秒从后端刷新。没有 `setInterval(() => progress++)`，因此 UI 不会制造假进度。
