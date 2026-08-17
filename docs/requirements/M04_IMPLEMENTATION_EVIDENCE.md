# M04 知识加工、质量与审核：实施证据

> 日期：2026-08-18。本文区分已执行的代码/数据库证据与仍需在内网和完整基础设施环境补跑的质量、容量证据。

## 1. 需求映射

| 需求    | 主要实现                                                           | 自动化证据                            |
| ------- | ------------------------------------------------------------------ | ------------------------------------- |
| KNO-001 | `knowledge-processing.ts`、M04 migration、PG mapper                | Zod 歧义关系/审核反例、migration gate |
| KNO-002 | `structure-recovery.ts`                                            | 标题树、跨页、脚注、装饰过滤测试      |
| KNO-003 | `chunk-builder.ts` 的 prose/table/code/FAQ/clause/slide/sheet 路由 | 5 类 Golden + core unit               |
| KNO-004 | Parent/Child、neighbor、header、footnote、source relations         | relation unit + Snapshot              |
| KNO-005 | boundaryKey + compatibleKind                                       | 表格、条款、代码、FAQ 边界测试        |
| KNO-006 | `displayContent/embeddingText` 独立字段                            | FAQ/标题上下文 Snapshot               |
| KNO-007 | `Cl100kTextTokenizer`、最终 embedding 二次预算校验                 | 长代码 64-token 硬上限回归            |
| KNO-008 | SHA-256、原子重复隔离、可逆 dedup、DUPLICATE_OF                    | 跨页重复字段评测与 Snapshot           |
| KNO-009 | `quality-policy.ts` 十类指标/发现项                                | PASS/MANUAL/REJECT 单测               |
| KNO-010 | 版本化三态 Policy 与报告                                           | Policy + Application 单测             |
| KNO-011 | M04 查询/Chunk/审核 API、管理台四组件                              | OpenAPI gate、Vue 可见行为测试        |
| KNO-012 | REVIEW、原因、行锁、乐观锁、immutable review/audit                 | 真实 PG 并发 winner + 直调越权测试    |
| KNO-013 | `eligible_for_index` 默认 false，事务放行合格 Child                | PASS/复核/重复资格集成断言            |
| KNO-014 | reprocess 新 revision/job steps/outbox，旧事实保留                 | 真实 PG revision 1/2 共存测试         |
| KNO-015 | `golden-manifest.json`、5 Snapshot、10 项字段准确率                | Snapshot 5/5、字段检查 10/10          |

## 2. 已执行门禁

```text
Backend tests: 108 passed
Frontend tests: 7 passed
M04 PostgreSQL integration: 3 passed
M01～M04 integration excluding infra-health: 11 passed
Chunk Golden: 5 snapshots passed; field checks 10/10
TypeScript strict + Vue typecheck: passed
ESLint max warnings 0: passed
Dependency boundaries: passed (207 modules / 426 dependencies)
Migration checksum/order: passed (4 migrations)
OpenAPI current: passed (2 files)
Docker Compose static config: passed
4 backend builds + Vue production build: passed
Production dependency audit (high): no known vulnerabilities
```

全套 integration 中独立的 M00 `infra-health` 用例未通过：当前本机 PostgreSQL、两套 Redis 为 up，MinIO 与 Milvus 未启动。M04 的三个真实 PostgreSQL 场景全部通过；不把未启动依赖写成通过。

## 3. 关键一致性与安全证据

- M03 完成、CHUNK 排队和 M04 Outbox 在同一 PG 事务中提交。
- M04 begin/complete/fail 使用 lease owner + expiry fencing，过期 Worker 不能提交。
- Chunk、关系、报告、finding、步骤推进原子提交；未知异常不能产生 PASS。
- API 使用 Application REVIEW 授权，Repository 再按文档 Space 执行直接 ACL 防御。
- 审核使用行锁 + expectedVersion；并发提交只有一个成功，审核历史只追加。
- 硬 REJECT 不能人工批准；复核未通过、Parent 和被抑制重复内容没有索引资格。
- reprocess 不覆盖旧结果，新 revision/job/outbox 在同一事务创建。
- 指标只使用有限 `result` 标签，不记录正文、userId、文档 ID、审核原因或 URL。

## 4. 配置与外网/内网边界

外网使用 `js-tiktoken@1.0.21` 的 `cl100k_base`，它是真实 BPE，适合验证硬上限和工程链路，但不宣称与 DeepSeek 或内网 Embedding 的 tokenizer 一致。接入内网时必须增加匹配模型的 Adapter/Profile，以新 revision 跑 Golden、检索评测和重处理。

M04 不直接调用 LLM、Embedding、Reranker、OCR 或 Milvus：OCR 属于 M03，Embedding/Milvus 属于 M05，LLM/Reranker 属于后续在线问答模块。这个边界避免知识审核结果尚未通过就写入正式向量索引。

## 5. 尚未完成的环境与业务验收

- 用内网 Embedding 官方 tokenizer 重跑 token/分块 Golden；
- 使用批准脱敏的复杂合同、制度、Excel、PPT、扫描 PDF 做字段准确率基线；
- 启动 D 盘 Docker data-root 上的 MinIO/Milvus 后补全 `infra-health`；
- 做中型规模并发入库、审核冲突、Worker kill、8 小时以上 soak；
- M05 完成后验证只有 eligible Child 被向量化，发布前后检索可见性正确。

这些不影响 M04 代码需求已落地，但属于企业上线前的跨模块/真实环境门禁，不能用合成 Fixture 替代。
