# 查询规划与混合检索 验收记录：Query Plan 与混合检索

## 已完成范围

- RET-001～RET-017 的代码、契约、迁移、Adapter、LangGraph、API、指标、测试和学习文档。
- 实际图文件：`libs/rag-graph/src/hybrid-retrieval.graph.ts`。
- 调试 API：`POST /api/v1/runs/{runId}/retrieval-debug`。

## 自动化证据

| 门禁                             | 证据                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| 路由/字面量/Filter/RRF/多样性    | `libs/retrieval/src/hybrid-retrieval-core.spec.ts`                                 |
| LangGraph/并行降级/两轮/调试权限 | `libs/rag-graph/src/hybrid-retrieval.graph.spec.ts`                                |
| Nest 模块真实装配                | `apps/rag-query-service/src/hybrid-retrieval/hybrid-retrieval.smoke.spec.ts`       |
| LLM Provider 契约                | `libs/model-gateway/src/query-rewrite.adapter.spec.ts`                             |
| Milvus Dense/Sparse 安全 Filter  | `libs/persistence-milvus/src/milvus-vector-index.adapter.spec.ts`                  |
| 真实 PG 批量回源                 | `test/integration/hybrid-retrieval-source.integration.spec.ts`                     |
| 黄金集和质量指标                 | `test/fixtures/hybrid-retrieval/golden-retrieval.json`、`golden-retrieval.spec.ts` |
| OpenAPI                          | `openapi/generated/rag-query-service.json`                                         |

## 质量结果

合成/公开黄金集门禁：Recall@40=100%、Hit@5=100%、版本准确率=100%、越权泄漏=0。
这些结果证明算法和安全门禁，不冒充内网真实模型质量。真实 BGE/Milvus 的业务脱敏 Golden、P95 和
中型规模容量结果必须在内网部署时按 Runbook 补跑。

本轮外网验收结果：后端 50 个套件、228 个测试和 19 个快照通过；前端 5 个测试文件、7 个测试通过；
身份权限与知识空间～查询规划与混合检索 的 8 个真实 PostgreSQL/Redis 业务集成套件、22 个测试通过。TypeScript、ESLint、依赖边界、
格式、OpenAPI、14 个迁移、离线依赖、生产依赖安全审计、全量构建和三套 Docker Compose 配置门禁通过。

当前未启动 Milvus/MinIO 容器，以避免 C 盘空间不足，因此没有执行只检查全部容器在线状态的
`infra-health.integration.spec.ts`；查询规划与混合检索 的 Milvus Dense/Sparse 安全契约由 Adapter 单测覆盖，真实
内网 Milvus/BGE 端到端质量与容量签字仍属于 评测与可靠性 上线门禁。

## 安全结论

- HTTP/LLM 无 SQL 或 Milvus expression 输入字段。
- Debug 同时要求 Run owner 和 SYSTEM_ADMIN/AUDITOR，响应无问题与 Chunk 正文。
- Redis Key 不含正文且绑定权限范围；缓存故障不跳过 PG 复核。
- 归档、未来生效、Manifest 版本错误、撤权和伪造允许空间列表均返回空候选；PG 会再次按
  `user_id + roles + resource_acl` 复核。
- Dense/Sparse 均不可用才失败；单路失败有显式 degraded 指标。

## 后续边界

- 证据、生成与答案校验 已复用本检索子图并接入 Run 完成链，详见对应验收记录。
- 评测与生产可靠性 才完成真实内网中型负载、长稳、Chaos、Dashboard 和生产阈值签字。
