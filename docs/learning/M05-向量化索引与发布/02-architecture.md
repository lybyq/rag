# 02｜架构：PG、模型服务、Milvus 如何协作

## 1. 主链路

```text
M04 eligible Child
  → ingestion-worker 领取 EMBED lease
  → Embedding /health + /metadata 兼容检查
  → Registry 解析 Profile Collection
  → PG 创建 BUILDING Manifest + 完整成员快照
  → Hash 命中复用，缺失项动态批量调用 Embedding
  → Milvus 写 manifest_id 隔离的候选行
  → PG/Milvus 对账
  → VERIFIED
  → 普通任务：PG 原子切 Head
  → rollout：EVALUATING，稳定 Head 不动
```

## 2. 分层边界

- `libs/contracts`：Zod 契约和 API Schema。
- `libs/retrieval`：批处理、对账、发布状态和灰度分桶纯规则。
- `libs/application`：Indexing、Maintenance、ProfileRollout 用例和 Port。
- `libs/model-gateway`：HTTP/Fixture Embedding 协议。
- `libs/persistence-milvus`：Milvus/Memory 向量行为。
- `libs/persistence-pg`：Registry、Manifest、Head、Outbox 和 lease 事务。
- ingestion-worker：文档主链路。
- scheduler-worker：周期对账、清理和 rollout。
- platform-api：只提供查询、回滚、重建、提升入口。

Domain/Application 不读取 `MILVUS_ADDRESS` 或厂商响应字段。带入内网时，协议相同只改配置；协议不同只新增 Adapter。

## 3. 数据可见性

```text
Milvus Collection
  ├─ manifest A rows  ← stable Head → 普通用户可见
  ├─ manifest B rows  ← BUILDING/VERIFIED → 不可见
  └─ manifest C rows  ← SUPERSEDED → 保留期内可回滚
```

Milvus Alias 只代表 Profile 对应的物理 Collection，不代表哪个业务快照在线。业务可见性一定回到 PG Head。

## 4. 故障边界

- Embedding 429/5xx：仅重试明确失败项，次数有限。
- Embedding Schema/维度错：终止，不写错误事实。
- Milvus 部分失败：只重试失败 vectorId；耗尽则 Manifest FAILED。
- 对账失败：不切 Head。
- PG 发布事务失败：Milvus 候选成为不可见垃圾，由维护任务清理。
- 旧向量清理失败：稳定 Head 已成功，不反向回滚。
- rollout 期间有新发布：Head 比较失败，返回 409，重新构建。

## 5. 内网部署含义

内网只有一个登录体系，调用上下文仍是 `userId + roles`。Profile CANARY 使用 userId 稳定分桶，不引入 tenantId。Milvus、Embedding 和认证密钥由环境/Secret 注入，Manifest 中只记录非敏感版本事实。
