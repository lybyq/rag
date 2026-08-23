# 证据生成与答案校验：代码执行顺序详解

## 1. Run 领取与身份恢复

1. `AnswerExecutionScheduler` 定时调用 `claimAcceptedRuns`。
2. SQL 使用 `FOR UPDATE SKIP LOCKED` 和 lease，多副本不会同时领取一个 Run。
3. Run 创建事务已保存可信角色与授权版本；恢复器核对 `rolesSha256` 和冻结版本。
4. 执行身份使用当前全局授权版本，避免 ACL 更新后命中旧权限缓存。
5. `RagRunLifecycleService.start` 把状态改为 RUNNING 并取得同一个 AbortSignal。

## 2. retrieve 与 rerank

1. 答案图调用第七阶段 `HybridRetrievalService`，问题只在服务内存解密。
2. 检索子图按当前 ACL 收窄空间并从 PG 回源正文。
3. Reranker 只收到配置上限内的候选，调用携带 Deadline、单次超时和 Run Signal。
4. 响应必须匹配 Run 冻结 revision，candidateId 必须来自请求，结果不能漏掉 TopN。
5. 可重试错误最多重试一次；策略允许时回退 RRF 顺序并记录 degraded。

## 3. expand、build 与 route

1. `PostgresEvidenceSourceRepository` 用 JSON 参数批量传入候选和 Manifest。
2. `valid_origin` 先校验 ACL、空间、Manifest、成员、文档、版本、revision 和生效期。
3. 只有同加工 Run、同文档版本和同 revision 的关系能扩展；表头 Block 也检查版本。
4. EvidenceBuilder 随机生成 sourceId，按 Reranker/RRF/权威级别计算覆盖和置信度。
5. 金额、日期、版本、编号在不同来源出现唯一但不同的值时形成 Conflict。
6. Router 用固定规则选择七条路线；低置信才调用 LLM 排序，返回值只能改变已有 sourceId 顺序。

## 4. context、calculation 与 draft

1. ContextBuilder 限制总 Token 和单文档数量，优先保留高分且多样的来源。
2. 每段来源包在服务端边界内，正文标成 `untrusted_data`；伪造闭合标签会被转义。
3. 白名单算术和日期差只在引用来源同时包含操作数时运行，保存表达式、结果与 sourceIds。
4. AnswerModel 只能返回 `AnswerDraftSchema`；每个 Claim 至少一个 UUID 引用。
5. DeepSeek 走 OpenAI-compatible JSON；内网 `http` 走固定三个结构化 Endpoint。

## 5. validate、regenerate 与 finalize

1. 发布前再次从 PG 获取当前有效 sourceId；撤权、过期或换版会立即消失。
2. Validator 检查引用存在、最终有效、计算结果、金额/日期/版本/编号、覆盖与冲突。
3. 只对 `supportMode=SEMANTIC` 且无确定性阻断的 Claim 调用 Judge，并记录模型版本与原因。
4. REGENERATE 把稳定 issue code 传给模型修复；总草稿数最多两份。
5. 第二份仍需修复就改为 REJECT，绝不把 REGENERATE 当 PASS。
6. Finalizer 产生五种状态；只有最终 Claim 使用的 sourceId 会持久化为答案引用。
7. `completeRun` 在同一事务插入加密答案、引用、校验报告、完成 Run 和 Outbox 事件。

## 6. 引用与反馈

1. `GET /api/v1/citations/{citationId}` 不接受文档或 Chunk 主键。
2. 每次预览重新检查 owner、ACL、Manifest、版本和生效期，只返回最小摘录与定位。
3. 反馈保存 rating、稳定 errorTypes 和可选 comment；messageId 自然关联 Run、引用和报告版本。
