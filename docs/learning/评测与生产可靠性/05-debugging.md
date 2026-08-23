# 评测与生产可靠性：调试与常见故障

先用同一 `traceId` 关联 auth、planning、embedding、search、PG validation、rerank、evidence、LLM、validation、persistence 和 SSE。再判断是数据质量退化、资源饱和还是单个 Provider 故障。

- 大量 429：看哪个流控维度命中，不要直接提高全局额度；先处理热点用户或空间。
- 熔断持续 OPEN：确认根因已恢复，再看 HALF_OPEN 探测；不要重启所有实例制造同时探测。
- 指标均值正常但方差升高：下钻失败 Case，常见原因是特定格式、版本或角色。
- SSE backlog 增长：看 Outbox 未发布数、锁超时、Stream 长度和连接数；事件可补发，答案事实以 PG 为准。
- 备份摘要失败：停止恢复并重新复制备份，不能跳过校验。
- Milvus 不一致：冻结发布，按 active Manifest 从事实源重建，禁止手工改 Head 掩盖问题。

完整处置命令和退出条件见 `docs/runbooks/production-reliability.md`。
