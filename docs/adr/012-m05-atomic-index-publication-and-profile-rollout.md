# ADR-012：M05 原子索引发布与 Profile Rollout

- 状态：Accepted
- 日期：2026-08-22
- 关联需求：IDX-001～IDX-016
- 细化：ADR-005

## 背景

Milvus 写入不是事务。若把“写进 Collection”直接当成“已经上线”，批次失败、Worker 崩溃或模型维度配置错误都会让用户看到半套知识。Embedding 升级还会同时改变 tokenizer、向量维度、归一化、Sparse 格式和查询/文档模板，不能只改一个模型名称。

## 决策

1. PostgreSQL `space_manifest_heads` 是线上可见性的唯一事实源；Milvus 行必须携带 `manifest_id`，普通检索只能使用 Head 解析出的 ID。
2. 每次构建创建不可变 `space_manifests` 和成员快照，状态依次为 `BUILDING → VERIFIED → ACTIVE`。Milvus 写入和对账期间 Head 不变。
3. 对账检查数量、主键集合、内容 Hash、Embedding Profile 和固定主键查询；只有通过报告才能在一个 PG 事务内降级旧 Manifest、激活新 Manifest、切 Head、完成 Job 并写 Outbox。
4. Embedding Profile 精确记录 provider、model/revision、protocol、tokenizer、维度、归一化、Sparse 格式以及 query/document 模板。兼容性摘要不同就使用独立 Collection；业务层不得拼 Collection 名。
5. Embedding 事实按 `content_sha256 + embedding_profile_id` 复用，Chunk 到事实的来源关系独立保存，复用计算不复用 ACL。
6. 新 Profile rollout 先构建 `VERIFIED` 候选。离线评测使用每个文档的代表 Child 走 query 端点并查询候选 Manifest；报告只保存计数、Recall 和脱敏摘要。
7. `FULL` 评测通过后原子切 Head；`CANARY` 只写 `space_manifest_canaries`，稳定 Head 不变。M07 按 `routing_salt + userId` 稳定分桶。提升和请求级回退均再次校验 Head，防止覆盖期间的新发布。
8. 发布、废止、撤权、灰度、提升和回退通过同一 PG 事务写 Outbox。`aggregate_id` 标识事件实例（Manifest、PolicyVersion 或 RebuildRequest），消费者收据保证幂等。
9. 旧 Manifest 保留期后异步清理；删除失败只进入维护告警。周期任务用 lease + `SKIP LOCKED` 对账 PG、MinIO、Milvus，只自动补写缺失向量，Hash/Profile 错误进入人工处理。

## 版本语义

| 版本                   | 含义                           | 何时变化                            |
| ---------------------- | ------------------------------ | ----------------------------------- |
| `documentVersion`      | 用户业务文件版本               | 上传一个新业务版本                  |
| `contentRevision`      | 同一文件的解析/知识加工修订    | 重处理或 Profile rebuild 重新跑输入 |
| `embeddingRevision`    | 某文档在 Manifest 中的向量修订 | 内容或 Embedding Profile 改变       |
| `spaceManifestVersion` | 空间完整可检索成员快照         | 每次候选构建                        |
| `embeddingProfileId`   | 不可变模型与协议组合           | 任一兼容性字段改变                  |

## 备选方案

- 原 Collection 原地覆盖：节省存储，但中间态可见且无法证明回滚点。
- 只切 Milvus Alias：无法与 PG 文档成员、Outbox 和审计形成同一事务。
- 每个文档单独在线：发布一份文档时难以保证空间其他成员不消失。
- CANARY 直接随机：同一用户跨请求抖动，评测和会话无法解释。

## 结果与代价

线上读取只看到完整、可审计、可回退的快照；代价是候选期双份向量、PG 关系表和异步清理任务。中型规模以可靠性优先，后续通过事实复用、批处理和保留期控制成本。
