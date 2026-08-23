# 证据、生成与答案校验验收记录

## 已完成范围

- ANS-001～ANS-020 的契约、领域规则、Provider Adapter、LangGraph、PG 迁移、后台执行、引用 API、
  结构化反馈、指标、安全回归、Golden、双环境配置和学习文档。
- 主图：`libs/rag-graph/src/answer-generation.graph.ts`。
- 后台入口：`AnswerGenerationExecutionService` + `AnswerExecutionScheduler`。
- 引用 API：`GET /api/v1/citations/{citationId}`。

## 自动化证据

| 门禁                                | 证据                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 契约与结构化 Claim                  | `libs/contracts/src/answer-generation.spec.ts`                                                         |
| Evidence/Context/计算/七路线 Golden | `libs/evidence/src/evidence-core.spec.ts`、`test/fixtures/answer-generation/golden-answer-routes.json` |
| Validator 与安全回归                | `libs/answer/src/answer-validator.spec.ts`                                                             |
| Reranker/LLM Provider 错误矩阵      | `libs/model-gateway/src/*adapter.spec.ts`                                                              |
| LangGraph 与降级                    | `libs/rag-graph/src/answer-generation.graph.spec.ts`                                                   |
| 真实 Nest 组装                      | `apps/rag-query-service/src/answer-generation/answer-generation.smoke.spec.ts`                         |
| PG 扩展、复核、引用事务、预览、反馈 | `test/integration/hybrid-retrieval-source.integration.spec.ts`                                         |
| OpenAPI/迁移                        | `openapi/generated/rag-query-service.json`、`20260825100000_answer_evidence_and_validation.sql`        |

## 安全结论

- LLM 不能决定 Evidence Route、权限、版本、Final Status，也不能引用请求集合外的 sourceId。
- Parent/Neighbor/Table Header 与最终 Citation 都执行当前 PostgreSQL 复核。
- 确定性阻断不能被 Semantic Judge 覆盖；修复循环上限为一次。
- 中间事件不含 Draft/正文/证据；完成事务前客户端看不到最终正文和引用。
- 引用使用不透明 UUID，预览在撤权、过期、换版后统一 404。
- Prompt Injection、伪造引用、无支持关键字面量和敏感错误输出已有回归。

## 外网与内网边界

外网已用 Fixture/Mock Provider 和真实 PostgreSQL 验证控制流与安全事实。这不冒充内网真实模型质量。
内网上线仍要填写实际 LLM/Reranker revision，并在评测与生产可靠性阶段使用批准脱敏集签字 Citation
Precision、Unsupported Claim Rate、拒答质量、P95、容量和故障演练。

## 本轮门禁结果

- `pnpm check` 全量通过：格式、ESLint、TypeScript/Vue、依赖边界、后端与前端测试、迁移、离线
  依赖审计、五个后端应用与 Web 构建、OpenAPI、外网/应用/内网三套 Docker Compose 配置。
- 最终全量后端 58 个套件、281 个测试与 19 个快照通过，其中包含 Validation/Final Status/
  Degradation Golden 和 AnswerModel 错误矩阵。
- 真实 PostgreSQL/Redis 业务集成（跳过未启动的 MinIO/Milvus 总健康检查）8 个套件、23 个测试通过；
  本模块新增用例覆盖证据扩展、过期复核、引用事务、引用预览和结构化反馈。
- 15 个迁移文件通过不可改写校验，新迁移已在本地 PostgreSQL 实际应用。
