# M02 测试：验证故障窗口，不只验证 Happy Path

## 1. 测试分层

| 层级          | 目标                                        | 代表文件                                     |
| ------------- | ------------------------------------------- | -------------------------------------------- |
| 领域单元      | 状态跳转、权重、稳定 ID、文件名净化         | `ingestion-core.spec.ts`                     |
| 应用单元      | 200 MiB 直传、HEAD 拒绝、补偿、Outbox       | `document-ingestion.service.spec.ts`         |
| Adapter 契约  | MinIO 签名参数、metadata、错误和取消        | `minio-object-storage.adapter.spec.ts`       |
| PG 集成       | 真实事务、行锁、幂等、Inbox、lease          | `m02-document-ingestion.integration.spec.ts` |
| Web 构建/检查 | Vue 类型、组件边界、桌面/移动视觉和错误日志 | `pnpm check` + 浏览器验收                    |

## 2. 为什么 200 MiB 测试不真的创建 200 MiB Buffer

验收目标是“字节不经过 API”，不是压测内存。测试提交 `sizeBytes=200 MiB` 的元数据，断言：

- 选择 Multipart；
- 计算 25 个 8 MiB 分片；
- 调用 MinIO initiate；
- Repository 命令不包含 Blob/Buffer；
- objectKey 不含原始文件名。

真实吞吐和长时间稳定性属于 M09 Load/Soak，不应该让单元测试分配巨型内存。

## 3. 事务失败测试

集成测试先提交非法 SHA-256 触发数据库 CHECK 失败，再查询空间文档数必须仍为 0。随后用合法事实重试并连续 Complete 两次，断言：

```text
documents = 1
ingestion_jobs = 1
outbox_events = 1
steps = 10
```

这比只断言第二次 HTTP 200 更有价值，因为它直接检查事实没有重复。

## 4. Outbox/Inbox 测试

- Publisher A 领取事件后，Publisher B 在 lease 内领取数为 0。
- 同一 eventId 第一次 Consumer 返回 true，第二次返回 false。
- Inbox 处理后只出现一条 `ingestion.waiting`。
- Publisher 调用失败时不能标记 published，必须 release 并设置下一次 availableAt。

## 5. Lease 测试

1. Worker A 成功 acquire。
2. Worker A 上报 5/10，断言 stage=50、overall=4。
3. Worker B 使用相同 Job 上报，返回 undefined。
4. 人工把 leaseExpiresAt 调到过去。
5. Scheduler recover，断言 status=QUEUED、attempt=2。

## 6. 常用命令

```powershell
# M02 纯逻辑与 Adapter
pnpm exec jest --runInBand libs/ingestion-core
pnpm exec jest --runInBand libs/application/src/document-ingestion.service.spec.ts
pnpm exec jest --runInBand libs/persistence-minio

# 真实 PostgreSQL/Redis 环境
pnpm db:migrate
$env:RUN_INTEGRATION_TESTS='true'
pnpm exec jest --runInBand --config test/jest-integration.config.cjs `
  test/integration/m02-document-ingestion.integration.spec.ts

# 全量门禁
pnpm check
```

## 7. 仍需在有镜像网络的环境验证什么

MinIO 真实集成要覆盖：浏览器 CORS、ETag 暴露、单 PUT、Multipart 合并、abort、HEAD metadata 和会话过期后的旧 URL 拒绝。本机如果 Docker Registry 超时，契约测试可以证明 Adapter 行为，但不能替代真实 MinIO 验收，证据文档必须明确区分。
