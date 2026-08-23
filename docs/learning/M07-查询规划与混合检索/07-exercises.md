# M07 练习

1. 给字面量提取增加“季度/财年”，先写重叠位置失败测试。
2. 构造 Dense 第 1/Sparse 未命中及反向案例，手算 `rrfK=60` 得分。
3. 把 `maxPerDocument` 从 3 改成 1，观察黄金集 Hit@5。
4. 让 LLM 返回五个子问题并遗漏金额，验证最终只有四个且金额被恢复。
5. 模拟 Dense 超时、Sparse 成功，检查 debug 响应和降级指标。
6. 把文档 `effective_to` 设为过去，验证正文不能回传。
7. 解释为什么原始 question 不能放进 Redis Key，并列出当前摘要字段。
8. 设计 M08 如何复用 `M07RetrievalService.retrieve` 并记录 Run Step/事件。
