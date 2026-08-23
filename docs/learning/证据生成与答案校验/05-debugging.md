# 证据生成与答案校验：调试方法

## 从 Run 开始，不从模型回答开始

1. 查 Run 状态和 `optimistic_version`。
2. 查 `rag_run_steps`，定位最后一个固定 nodeKey 和 attempt。
3. 查 `answer_validation_reports.validation_report` 的稳定 issue code。
4. 观察答案四类 Prometheus 指标，确认是普遍问题还是单 Run 问题。
5. 只有在获批脱敏环境中才查看 Evidence 内容；普通日志不输出正文。

## 典型定位

- 卡在 `answer_rerank`：检查模型健康、协议、revision、候选/Token 上限和 Deadline。
- 卡在 `answer_expand_evidence`：检查当前 ACL、Manifest status/member、文档版本/revision、生效时间。
- 路由总是 LLM_RERANK：检查 Reranker 分数标定、覆盖阈值和权威来源标题，不要直接调低门槛。
- `CITATION_REVALIDATION_FAILED`：生成期间发生撤权、过期或换版，这是正确阻断。
- `DETERMINISTIC_LITERAL_UNSUPPORTED`：模型写了来源中不存在的金额/日期/版本/编号。
- `SEMANTIC_CLAIM_UNSUPPORTED`：Judge 认为语义证据不足；先改知识和 Prompt，不放宽确定性规则。
- 预览 404：按 fail-closed 顺序查 owner → ACL → Manifest → version/revision → effective window。

## 禁止的调试捷径

不要直接把 Validation Outcome 改 PASS、不要从历史缓存返回撤权引用、不要把完整 Prompt/证据写日志、
不要增加无界重试，也不要让前端用数据库主键拼 citation URL。
