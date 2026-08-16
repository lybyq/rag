# ADR-001：四进程与分层边界

- 状态：Accepted
- 日期：2026-08-15
- 关联需求：BASE-002、BASE-004、BASE-005

## 背景

管理请求、在线问答、重型文档处理和周期调度的资源曲线完全不同。若部署为单进程，OCR 峰值可能拖慢在线问答，定时任务异常也会扩大故障半径。

## 决策

采用 `platform-api`、`rag-query-service`、`ingestion-worker`、`scheduler-worker` 四个 Nest 应用。共享代码位于 `libs`，方向为 `contracts/domain → application → adapter → app composition root`。Domain/Application 禁止依赖数据库、模型 SDK 和 App。

## 备选方案

- 单体单进程：开发简单，但资源隔离、独立扩容和 SLO 隔离差。
- 大量微服务：边界更细，但中型规模下部署、网络和一致性成本过高。

## 结果

四类负载可独立扩容和重启，代价是部署单元增多。依赖规则由 ESLint 与 dependency-cruiser 双重检查，避免目录约定逐渐失效。
