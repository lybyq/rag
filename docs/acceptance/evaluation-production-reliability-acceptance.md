# 评测与生产可靠性验收记录

验收日期：2026-08-23

## 已完成范围

| 需求         | 证据                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| OPS-001～003 | `libs/contracts/src/evaluation.ts`、`libs/evaluation`、Evaluation Service/Repository/Worker、迁移；保存版本快照、均值、方差和失败样本 |
| OPS-004      | `evaluation/golden/pr-selected.json`、`run-golden-regression.ts`、`release-gate.ts`；PR 选定集和真实 Baseline 分层门禁                |
| OPS-005～006 | Operations Dashboard、心跳、队列/Outbox/Provider 聚合；现有 OpenTelemetry 节点 Trace 与 Run Step 事实                                 |
| OPS-007      | Redis 原子多维流控和并发舱壁，覆盖全局/用户/角色/空间，故障 fail-closed                                                               |
| OPS-008      | resilience 统一 Deadline、单次超时、取消、错误分类、白名单重试、退避和熔断；模型 Adapter 已接入                                       |
| OPS-009      | 在线 cache、BullMQ 离线 Redis、连接池与队列职责分离，评测运行进入离线 Worker                                                          |
| OPS-010      | k6 六场景脚本：基线、日常入库、批量导入、冷热缓存、依赖故障、SSE 断连                                                                 |
| OPS-013      | PG/MinIO/配置备份恢复，递归摘要、恢复确认和 Milvus 事实源重建脚本                                                                     |
| OPS-015～016 | migration phase 检查与 destructive review；Run 冻结 Feature Flag，Flow/Profile/Prompt/Manifest 独立版本/回滚                          |
| OPS-017～018 | `production-reliability.md`、`compliance-operations.md`、`backup-restore.md`，审计筛选/脱敏导出和合规幂等任务表                       |
| OPS-019      | CI 的 Golden、E2E、迁移、SBOM/扫描；标签真实评测门禁后发布 SHA 不可变 OCI 镜像及 provenance                                           |

## 自动门禁证据

- `pnpm evaluation:golden`：6 Cases、11 Metrics 通过。
- `pnpm migration:check`：迁移阶段和破坏性变更注释检查通过。
- `pnpm openapi:generate && pnpm openapi:check`：评测/运维契约已生成并无漂移。
- 评分、Service、Redis 流控、resilience 和模型适配器测试由后端 Jest 覆盖。
- 长稳、Chaos 和灾备的报告格式及命令已固化在 Runbook。

## 仍需真实环境验收，不虚假勾选

| 需求    | 当前状态            | 完成条件                                                                                     |
| ------- | ------------------- | -------------------------------------------------------------------------------------------- |
| OPS-011 | 待执行              | 在候选内网容量连续运行 24～72 小时，内存、连接、Stream、临时文件和队列无明显泄漏，并归档报告 |
| OPS-012 | 待执行              | 实际注入 Redis、Milvus、模型、Worker/API 单实例和网络延迟故障，验证恢复与无权限旁路          |
| OPS-014 | `RPO=TBD / RTO=TBD` | 业务确认目标；隔离恢复演练测得实际 RPO/RTO 并经审核                                          |
| OPS-020 | 待容量报告          | 完整 Golden、性能、可靠性、权限和安全总指标全部达到 PRD                                      |

这些项不阻塞本地功能学习，但会阻止“生产容量验收完成”的结论。
