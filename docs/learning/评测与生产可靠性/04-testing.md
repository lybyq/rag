# 评测与生产可靠性：测试策略

- 单元：评分器阈值、均值/方差、Baseline 方向、重试白名单、超时、取消和熔断状态。
- Adapter：Redis 原子流控覆盖用户/角色/空间、TTL、释放与 fail-closed；模型适配器覆盖 Schema、429、5xx 和 revision。
- 集成：Evaluation Repository、Worker lease、Feature Flag 快照、审计导出和队列事实。
- PR：`pnpm evaluation:golden` 运行关键选定集。
- 性能：`K6_SCENARIO` 分别运行 baseline、daily_ingestion、bulk_import、cache_hot_cold、dependency_fault、sse_disconnect。
- 长稳与混沌：`pnpm soak` 和 `pnpm chaos` 输出报告；没有真实报告时 OPS-011/012 不算验收。
- 灾备：在隔离环境完成 backup、校验、restore、Milvus rebuild 和固定查询，记录实际 RPO/RTO。
