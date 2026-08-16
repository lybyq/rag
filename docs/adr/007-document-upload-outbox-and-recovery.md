# ADR-007：浏览器直传、事务 Outbox 与任务恢复

- 状态：Accepted
- 日期：2026-08-16
- 决策模块：M02

## 背景

中型企业知识库需要接收最多 100 个文件和至少 200 MiB 的单文件。如果文件先经过 Platform API，再转发到对象存储，API 会承担双倍网络流量、长连接、内存/临时盘压力，并扩大故障面。另一方面，对象上传成功与数据库建任务分属两个系统，不存在跨 MinIO/PG 的分布式事务。

## 决策

1. Platform API 只接收文件名、大小、MIME 和可选 SHA-256，生成与原始文件名无关的隔离对象路径。
2. 浏览器使用短时预签名 URL 直接 PUT MinIO；大文件使用 Multipart，前端按失败分片重试。
3. 完成接口先执行对象 HEAD。Multipart 重试先 HEAD 探测，处理“MinIO 已合并、PG 未提交”的不确定窗口。
4. Document、DocumentVersion、DocumentFile、IngestionJob、JobStep 与 Outbox Event 在一个 PG 事务提交。
5. Scheduler 使用 `FOR UPDATE SKIP LOCKED` 领取 Outbox；BullMQ `jobId=outboxEventId`，Consumer Inbox 收据与副作用同事务。
6. Worker 通过 lease owner 与 heartbeat 续租。Scheduler 对过期 lease 进行有限重试，超过上限转人工 `WAITING`。
7. SSE 以 PG 单调事件 ID 支持 `Last-Event-ID`；无法保持连接的客户端使用 ETag + 数值游标轮询。

## 后果

正向结果：API 不承载大文件字节；Complete 可重试；数据库事实和任务请求不会分裂；Publisher/Consumer 可横向扩容；页面刷新可以恢复事实状态。

代价：需要正确配置对象存储 CORS；预签名 URL 会过期；MinIO 完成与 PG 事务之间仍需通过 HEAD 收敛，而不是假设原子性；任务进度必须由 Worker 报告真实单位。

## 被拒绝方案

- API 代理文件：资源成本和故障面过高。
- 上传完成后直接发 Redis，再写 PG：进程崩溃会丢任务或产生孤儿消息。
- 用前端定时器平滑增加进度：它无法代表解析/OCR/向量化真实工作量。
- 用原始文件名拼对象 Key：会产生目录穿越、重名覆盖和敏感名称泄露风险。
