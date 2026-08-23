# 证据、生成与答案校验运行手册

## 启动前检查

1. 执行 `pnpm db:migrate`，确认 `20260825100000_answer_evidence_and_validation.sql` 已应用。
2. 外网开发可保留 `RERANKER_ADAPTER=fixture`；DeepSeek 使用现有 `LLM_ADAPTER=openai-compatible`、
   `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL_ID` 和 `LLM_REVISION`。
3. 内网把 `RERANKER_ADAPTER=http`，并填写 `RERANKER_BASE_URL/MODEL_ID/PROFILE_ID/REVISION`；
   LLM 可用 `http` 内网协议或 `openai-compatible` 协议。业务代码无需改动。
4. `ANSWER_STRICT_STREAMING` 和 `ANSWER_MAX_REGENERATIONS` 固定为 `true` 与 `1`；启动配置会拒绝
   关闭发布门禁或放大重生成循环。
5. 确认 Reranker `/health`、`/v1/metadata`、`/v1/rerank` 与配置的 revision/protocol 匹配。

## 关键指标

- `rag_answer_evidence_routes_total`：七种证据路线分布。
- `rag_answer_validation_total`：PASS、REGENERATE、PARTIAL、REJECT。
- `rag_answer_degradations_total`：Reranker 或条件式 LLM 精排降级。
- `rag_answer_stage_duration_seconds`：每个固定图节点耗时。
- `rag_conversation_event_publish_lag_seconds`：最终事实到 SSE 可见的延迟。

## 常见故障

| 现象                 | 优先检查                                      | 处理                                        |
| -------------------- | --------------------------------------------- | ------------------------------------------- |
| Run 长时间 ACCEPTED  | Query Service 日志、execution lease、调度间隔 | 确认实例运行和数据库连接；不要手改终态      |
| Reranker 大量降级    | 模型健康、超时、revision、候选长度            | 修复内网 Gateway；是否允许回退由配置决定    |
| 大量 CONFLICT        | 文档版本、金额/日期/编号冲突                  | 由知识管理员确认权威版本，不调低冲突规则    |
| 大量 REJECT          | 引用再鉴权、生成 Schema、Validator issue      | 按稳定 issue code 聚合，不记录问题/证据正文 |
| 引用预览 404         | owner、ACL、文档状态、生效期、Manifest 成员   | 404 是 fail-closed，不能退回历史缓存摘录    |
| Draft 重生成后仍失败 | `answer_validation_reports`                   | 修 Prompt/模型或知识，不提高重试次数        |

## 安全排障原则

- 日志只允许 Run 阶段、稳定错误码、计数与耗时，不记录问题、完整证据、模型原始响应、密钥或 URL。
- 不直接更新 `answer_citations` 或 `answer_validation_reports` 来“放行”答案。
- 反馈说明属于用户内容，不复制到日志或 Prometheus 标签。
- 过期清理会覆盖答案正文和引用摘录，但保留 Hash、状态、路由、校验与反馈审计。

## 内网验收

使用批准脱敏 Golden 重跑七条 Evidence Route、四种 Validation Outcome、Reranker 超时、LLM 429/5xx、
撤权、换版、过期、伪造 citation、Prompt Injection 和最多一次重生成。最终再以中型规模并发测量 P95、
拒答率、Citation Precision、Unsupported Claim Rate 和 Provider 容量。
