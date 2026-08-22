# M05 向量化、索引与发布：实施证据

> 日期：2026-08-22。本文区分已执行的代码/真实 PostgreSQL 证据，以及必须带入内网后用企业 Milvus 和 Embedding 服务补跑的环境证据。

## 1. 需求映射

| 需求    | 主要实现                                               | 自动化证据                                             |
| ------- | ------------------------------------------------------ | ------------------------------------------------------ |
| IDX-001 | `EmbeddingPort`、`HttpEmbeddingAdapter`                | query/document、正常、429、5xx、Schema、超时、取消测试 |
| IDX-002 | `EmbeddingProfileSchema`、配置白名单                   | Zod 正反例、Profile mismatch 测试                      |
| IDX-003 | `EmbeddingStartupVerifier`、`assertProviderCompatible` | metadata 精确字段不匹配拒绝测试                        |
| IDX-004 | `embedding-batch.ts`                                   | Token 分批、并发、部分重试、背压、取消测试             |
| IDX-005 | `embedding_facts`、`chunk_embedding_refs`              | 真库相同正文两来源只保存一份事实                       |
| IDX-006 | `embedding_collection_registry`、Milvus/Memory Adapter | 兼容性 Hash、维度错配和独立 Collection 测试            |
| IDX-007 | `MilvusVectorIndexAdapter` Schema                      | 断言没有 display/embedding/full text 字段              |
| IDX-008 | ADR-012、Manifest/Member Schema                        | Migration 与契约测试                                   |
| IDX-009 | `BUILDING/VERIFIED` + `space_manifest_heads`           | 真库构建失败 Head 不变                                 |
| IDX-010 | `reconcileManifestRecords`                             | 数量、PK、Hash、Profile、固定查询正反例                |
| IDX-011 | `PostgresIndexingRepository.publish`                   | 连续发布、成员保留和 Head 原子切换真库测试             |
| IDX-012 | 空间 ACL/废止与索引发布/回退 Outbox                    | 撤权、废止、重复发布事件真库测试                       |
| IDX-013 | `fail`、lease fencing、失败 Manifest                   | Milvus 合成中断后旧 Head 精确不变                      |
| IDX-014 | 延迟 `CLEANUP_MANIFEST`                                | 清理失败重试且 ACTIVE 禁删单测                         |
| IDX-015 | `IndexMaintenanceService/Scheduler`                    | 缺失补写、Hash 异常人工、MinIO HEAD 测试               |
| IDX-016 | `ProfileRolloutService/Scheduler`、canary 表与路由     | 候选→评测→CANARY→提升→请求级回退真库测试               |

## 2. 已执行门禁

```text
Backend tests: 179 passed
M01～M05 PostgreSQL/Redis integration excluding infra-health: 15 passed
M05 PostgreSQL + Memory Vector integration: 4 passed
TypeScript strict + Vue typecheck: passed
ESLint max warnings 0: passed
Migration real apply/check: 9 migrations ready
```

完整 `infra-health` 当前仍会报告 MinIO/Milvus down，因为本机只启动了 PostgreSQL 和两套 Redis，且用户已说明 C 盘空间已满；没有为得到绿色结果而在 C 盘拉起重型镜像。M05 的真实 Milvus 验收留给 D 盘 Docker data-root 或内网环境。

## 3. 关键一致性证据

- 一个文档发布会复制旧 Head 的其他成员，再覆盖目标文档；真库断言第二版成员数为 2。
- 两个来源相同正文只生成一个 `embedding_facts`，Manifest 成员仍是两条，不合并来源与权限。
- Milvus/Memory 中出现候选向量时，PG Head 尚未变化；只有对账通过后的事务能改变可见版本。
- Outbox 的幂等键使用 Job、Manifest、PolicyVersion 或 RebuildRequest，而不是永远使用 spaceId，因此第二次合法发布不会被错误去重。
- 失败切换、旧 Worker lease、Profile 漂移和对账失败均 fail-closed。
- CANARY 不覆盖稳定 Head；提升前再次比较 `previous_manifest_id`，期间有新发布就返回 409。
- 请求级回退不接受客户端 Collection 名，只使用数据库冻结的 previous/candidate Manifest。

## 4. 内外网边界

外网默认 `fixture + memory` 可完整演练事务、批处理、对账和 rollout，但不能充当质量或 Milvus 性能证据。内网配置选择 `http + milvus`：只填写 Endpoint、密钥和不可变元数据；Controller、Use Case、表结构和状态机不改。

内网 Embedding 服务需要实现：

```text
GET  /health
GET  /metadata
POST /v1/embeddings  body.purpose = QUERY | DOCUMENT
```

启动时会比对 model/revision/protocol/tokenizer/dimension/normalize/sparse/capability。任一不一致，ingestion-worker 拒绝就绪；不会尝试把新维度写进旧 Collection。

## 5. 尚需内网补跑

- 企业 Milvus 版本上的 Dense/Sparse Schema、HNSW 参数、分页对账和删除耗时；
- 企业 Embedding query/document 模板与官方 tokenizer 精确一致性；
- 使用批准脱敏的问题集替代“代表 Chunk 自检”，确认业务 Recall 阈值；
- 中型规模动态批次、限流、Worker kill、Milvus 重启、8 小时 soak；
- M07 接入 `space_manifest_canaries` 后验证真实 userId 稳定分流和会话固定 Manifest。

这些是部署环境与业务质量验收，不是以 Fixture 冒充通过的项目。
