# 评测与生产可靠性：练习

1. 把 PR Golden 中引用文档替换成错误 UUID，观察 Case failure code 和聚合指标。
2. 给 resilience 测试增加“第一次 503、第二次成功”，验证 attempt 和 Deadline。
3. 同时对一个用户和一个空间施加并发，解释哪个 Redis key 先拒绝请求。
4. 在隔离环境篡改一个备份对象，确认恢复在执行 `pg_restore` 前终止。
5. 运行十分钟 k6 baseline，记录吞吐、P95、错误率和资源曲线；说明为什么它不能替代 24 小时 Soak。
6. 模拟 Reranker 超时，比较允许降级和禁止降级两种 Profile 的用户结果与 Trace。
