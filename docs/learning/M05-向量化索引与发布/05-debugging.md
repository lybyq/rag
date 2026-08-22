# 05｜调试与故障定位

## 1. Worker 启动失败

先看错误字段而不是先重试。常见不兼容：modelId、revision、protocolVersion、tokenizerRevision、denseDimension、normalizeDense、sparseFormatVersion、capability。检查内网 `/metadata` 原始响应，但不要把 API Key 或完整响应贴入日志。

## 2. Job 停在 EMBED

依次查：

1. `ingestion_jobs` 的 lease owner/expiry；
2. `indexing_runs.failure_code`；
3. `embedding_collection_registry` 是否已有同 profileId 的不同兼容 Hash；
4. Provider 429/5xx 指标和批次大小；
5. `embedding_facts` 是否存在错误维度。

不要手工把 Step 改成成功，否则后续会在缺事实时产生更难解释的失败。

## 3. Milvus 有数据但 API 查不到

这是可能的正确状态。先查记录的 `manifest_id`，再查 `space_manifest_heads.active_manifest_id`。若不同，说明是 BUILDING/VERIFIED/SUPERSEDED 候选。不要通过删除 Filter 或改 Alias 强行“修好”。

## 4. 对账失败

- COUNT/缺失 PK：可对 ACTIVE 安全补写缺失记录。
- 多余 PK：候选发布前失败；ACTIVE 不自动删除，进入人工分析。
- CONTENT_HASH/PROFILE：数据语义错误，禁止自动修。
- FIXED_QUERY：行存在但索引不可查询，检查 load/index 状态与 Milvus 日志。
- SOURCE_OBJECT：检查 MinIO Bucket、对象生命周期和 SHA metadata。

## 5. 第二次发布报 Outbox 唯一冲突

确认 `aggregate_id` 使用 Manifest/PolicyVersion/RebuildRequest 事件实例，而不是永久 spaceId。生产端唯一键用于重试去重，不能把合法的第二次发布也去重。

## 6. CANARY 一直 EVALUATING/FAILED

检查 Scheduler 是否选择与请求相同的 `EMBEDDING_PROFILE_ID`，评测 lease 是否过期，query 向量维度是否和候选一致，以及 Recall 门槛。不得为了变绿临时把阈值调成 0；先用失败报告摘要定位哪些文档没有命中。

## 7. 回退返回 409

说明 rollout 开始后稳定 Head 已变化，或者历史向量已被清理。409 是保护，不是数据库故障。先列 Manifest 历史和维护任务，明确当前线上事实，再重新构建候选。

## 8. 本机 C 盘已满

TEMP/TMP、pnpm store、Parser 临时目录放 D 盘。不要为跑 Milvus 直接继续向 C 盘 Docker data-root 写镜像；先迁移 Docker data-root。测试时可用 Memory Vector 验证代码链路，但验收记录必须明确真实 Milvus 未跑。
