# 生产可靠性运行手册

## 使用原则

先记录告警时间、环境、traceId/runId/jobId、当前版本和影响范围，再执行动作。默认只做可逆处置；禁止直接改业务状态、删除 Redis Stream 或手工切 Milvus Head。外网本地基础设施数据统一放 `D:\rag-runtime\docker`：

```powershell
pnpm infra:d-drive
pnpm health:deep
pnpm infra:d-drive:stop
```

## 卡住任务

判定：Operations Dashboard `stalled > 0`，且 lease 已过期、heartbeat 不再推进。

1. 用 Job/Run ID 查 PG 状态、attempt、leaseOwner、heartbeatAt 和最后一步 Trace。
2. 确认对应 Worker 实例是否存活；先摘除异常实例。
3. 只对 `retryable=true` 且幂等步骤执行受权重试；不可重试安全拒绝进入人工审核。
4. 观察新 attempt 是否续租并推进；退出条件是 backlog 和最老等待时间恢复基线。

## DLQ 或重复失败

1. 按稳定 errorCode 聚类，不逐条盲目重试。
2. Schema/版本不匹配先修配置或回滚应用；429/5xx 先恢复依赖；恶意文件保持隔离。
3. 修复后选一条合成样本验证，再限批回放；记录操作者、原因和批次。
4. DLQ 不得直接删除，达到保留期后由合规任务处理。

## Parser / OCR 故障

1. 检查 Parser readiness、OCR Profile 兼容性元数据、超时/429/5xx 和对象下载允许主机。
2. 原生解析成功但 OCR 失败时，仅在策略允许时降级；扫描件不得伪装为成功空文本。
3. 确认临时目录配额和清理，无论成功、失败或取消都不残留源文件。
4. 恢复后重处理固定 PDF/DOCX/图片样本，对比页码、表格和 OCR 置信度。

## 索引或 Manifest 不一致

1. 暂停新发布，读取 active Manifest、Embedding revision、dimension、metric 与 Collection alias。
2. 不兼容立即阻止查询；不要混用旧向量。
3. 使用 `pnpm milvus:rebuild` 从 PG/MinIO 事实源重建候选索引。
4. 验证向量数、成员数、固定查询和引用版本后原子切 Head；旧 Manifest 按保留期清理。

## Auth 故障或疑似越权

1. 立即关闭相关 Feature Flag 或停用入口，保留审计和 Trace。
2. 核对可信 Header/JWT 校验、userId、roles、authzVersion 和空间 ACL；不得用客户端角色作为依据。
3. 运行权限 Golden Set，确认 `PERMISSION_LEAK_RATE=0` 后再恢复。
4. 若出现泄漏，进入安全事件响应流程，不删除日志或失败样本。

## Redis Streams / Outbox 积压

1. 同时看 `rag-sse-outbox` waiting/active/delayed/error/DLQ/stalled 和 Redis Stream 长度。
2. 检查 Publisher 心跳、数据库锁和 Redis 连接；Outbox 记录是补发依据。
3. 修复后按 sequence 补发，客户端可从 `Last-Event-ID` 恢复；禁止跳号伪造完成。
4. PG 中 Run/Message 是最终事实，Stream 只负责传输。

## 模型超时、429 或熔断

1. 区分 LLM、Embedding、Reranker、OCR Profile，查看单次 timeout、剩余 Deadline 和 Circuit 状态。
2. 429 降低并发/速率；5xx 检查 Provider；Schema/revision 错误直接修配置，不重试。
3. 只有快照策略允许时才降级，例如 Reranker 回退 RRF；答案校验不能被绕过。
4. Provider 恢复后让 HALF_OPEN 少量探测，不要同时重启所有实例。

## SSE 连接激增或断连

1. 查看活跃连接、网关缓冲、心跳、每用户连接数和事件发送延迟。
2. 启用连接限额；客户端退回游标轮询，不创建重复 Run。
3. 运行 `K6_SCENARIO=sse_disconnect pnpm perf:k6` 验证释放和恢复。
4. 退出条件是连接数、Outbox backlog 和恢复延迟回到基线。

## 发布与回滚

1. PR 必须通过格式、Lint、类型、边界、单元、Golden、Playwright、迁移、OpenAPI、Compose 和扫描。
2. 标签发布先用 `RELEASE_EVALUATION_RUN_ID` 运行 `pnpm release:gate`。
3. 只部署提交 SHA 标签的不可变镜像，保留 SBOM、provenance 和扫描报告。
4. Flow、Profile、Prompt、Manifest、Feature Flag 可独立回退；数据库 Contract 只能在旧应用全部退场后执行。

## 压测、Soak 与 Chaos 证据

```powershell
$env:K6_SCENARIO='baseline'
pnpm perf:k6
pnpm soak
pnpm chaos
```

报告必须记录代码/配置/Manifest 版本、机器规格、数据量、持续时间、吞吐、P50/P95/P99、错误率、CPU、内存、连接、队列、临时文件和恢复时间。脚本存在不等于 OPS-011、OPS-012、OPS-020 达标。
