# M07 混合检索运行手册

## 上线顺序

1. 执行 `pnpm db:migrate`，确认 M07 migration 已应用。
2. 确认旧 `rag_runs.snapshot` 已回填 `retrieval`。
3. 配置真实 Embedding Profile；若启用 Sparse，输出模式和 sparse format version 同时配置。
4. 确认 M05 已用相同 Profile 重建并发布 Manifest。
5. 启动 `rag-query-service`，检查 readiness 和 `/api/v1/metrics`。
6. 用管理员/审计员对一个本人 Run 调用 retrieval-debug。
7. 核对两路状态、roundCount、回源移除和候选版本。

## 关键配置

`RETRIEVAL_INITIAL_TOP_K`、`FINAL_TOP_K`、`RRF_K`、Dense/Sparse 权重、文档/章节配额、最小结果数和
两轮上限均写入 Run 快照，修改后只影响新 Run。缓存 TTL 是运行时缓存策略，不改变检索语义，
因此不进入 Run 快照；无论缓存是否命中，PostgreSQL 当前权限复核都不会跳过。

## 故障处置

- 单路故障：允许短时 degraded，观察另一线路 Recall 和 P95；不要关闭 PG 回源。
- 两路故障：返回 503，检查 Milvus Collection、Profile 和网络；不得用缓存正文冒充答案。
- 大量 SOURCE_RECHECK_FAILED：检查 Manifest 切换、批量归档或系统时间。
- 版本不匹配：停止流量，核对 Query Service Embedding 配置与 active Manifest。
- 权限移除激增：先确认是否正常撤权，不要放宽 allowedSpaceIds 消除告警。

## 回滚

代码回滚前确认旧版本能否解析含 `snapshot.retrieval` 的 Run JSON。数据库新增列和 vectorId 保留，
不要逆向删除；应用使用 Expand→Migrate→Contract。Manifest 回滚使用 M05 原子 Head 操作。
