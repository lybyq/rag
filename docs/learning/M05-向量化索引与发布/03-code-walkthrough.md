# 03｜代码走读：按一次 M05 执行顺序

## 1. 配置启动

先读 `libs/config/src/app-config.ts`。Zod 把字符串环境变量转换为冻结的数字/布尔配置，并在 intranet Profile 下禁止 fixture、memory 和占位 Endpoint。`apps/ingestion-worker/src/embedding-startup.verifier.ts` 在 Nest 启动阶段调用 `verifyProviderCompatibility`，所以错误维度不会等到第一份文档才暴露。

## 2. HTTP Provider

读 `libs/model-gateway/src/http-embedding.adapter.ts`：

1. `checkHealth` 请求 `/health`，只判断服务真实响应。
2. `getMetadata` 请求 `/metadata` 并用 Zod 校验。
3. `embedDocuments/embedQueries` 固定传 `DOCUMENT/QUERY`。
4. `requestJson` 合并单次 timeout、绝对 deadline 和父级 AbortSignal。
5. 429、5xx、网络错误转换为稳定失败分类；Schema 错误不可重试。
6. 错误和日志不带正文、API Key 或完整响应。

## 3. 动态批处理

读 `libs/retrieval/src/embedding-batch.ts`：

1. `planEmbeddingBatches` 顺序扫描，item 数量和 token 总量任一到上限就封批。
2. 单条超过预算直接拒绝，绝不静默截断，因为 Hash 与语义会失真。
3. `executeEmbeddingBatches` 先检查总排队数，实现显式背压。
4. 固定数量 worker 共享 cursor，形成有限并发。
5. `executeOneBatch` 用 itemId/Hash 校验响应关联，只把 `retryable=true` 放回下一轮。
6. Provider 漏项或重复项变成 `SCHEMA_ERROR`，不能假装成功。

## 4. 创建构建快照

读 `PostgresIndexingRepository.beginRun()`：

1. `loadTargetForUpdate` 要求 M04 SUCCEEDED、quality eligible、Job lease owner 正确。
2. 同一 job 已有 Run 时复用；Profile 改变则拒绝把重试变成另一套事实。
3. 锁 knowledge_space，计算下一 Manifest version。
4. 复制当前 Head 的全部成员，并排除待覆盖的目标文档。
5. 插入目标文档新成员，汇总完整 expected vector count。
6. 写 `INDEX_RUN/SPACE_MANIFEST` 受保护资源映射。
7. 提交后再加载不可变 chunks；此时 Manifest 仍是 BUILDING。

## 5. 事实复用和向量写入

读 `IndexingService.resolveEmbeddingFacts()`。它先按 contentSha256 选代表 Chunk，批量查 `embedding_facts`，只把缺失 Hash 发给模型。保存事实使用 `INSERT ... ON CONFLICT DO NOTHING`，并发 Worker 最终都读取数据库真值。

`toVectorRecord` 生成 `sha256(manifestId:chunkId:profileId)` 主键，只把短摘要、heading/source 定位和向量交给 Milvus。完整 `displayContent/embeddingText` 留在 PG。

`writeVectorsWithRetry` 按有限 batch 写入，并只保留 Adapter 返回的 retryable IDs。终态失败立即停止。

## 6. 对账与普通发布

写完后读取候选 Manifest 的最小事实，再用头/中/尾固定 ID 查询。`reconcileManifestRecords` 对期望和实际排序后生成稳定 SHA 报告。`markVerified` 与报告在同一 PG 事务。

普通任务随后调用 `publish()`：锁 Job lease、Run、space 和 Head；旧 ACTIVE 变 SUPERSEDED，新 VERIFIED 变 ACTIVE；Head、Job、documentVersion、Outbox 与维护任务一起提交。任何 SQL 失败都会回滚全部可见性变化。

## 7. Rollout 分支

若 `IndexBuildInput.rollout` 存在，`IndexingService` 不调用普通 publish，而调用 `stageProfileCandidate`。它把请求推进 EVALUATING、完成入库 Job，但不改 Head。

`ProfileRolloutScheduler` 领取评测 lease。`ProfileRolloutService`：

1. 再次核对配置 Profile 与 Provider metadata。
2. 每个 Manifest 成员选择第一个 eligible Child 作为工程自检 query。
3. 调用 `embedQueries`，按候选 manifest_id 做 Dense TopK。
4. 计算命中文档数和 Recall；报告只保存摘要。
5. FULL 通过则原子激活；CANARY 通过只写 `space_manifest_canaries`。

`selectCanaryManifest` 用 SHA-256(`salt:userId`) 的前 32 位取模 100，确保同一用户稳定。API 的 promote/rollback 都再次比较 Head，避免覆盖并发新版本。

## 8. 维护链路

`IndexMaintenanceScheduler` 用 `SKIP LOCKED` 领取任务。对 ACTIVE Manifest 只自动补写缺失 PK；Hash/Profile/来源对象错误进入人工处理，绝不对线上数据先删后写。CLEANUP 到期后仍会再次检查 Manifest 是否 ACTIVE，回滚重新激活的版本禁止删除。
