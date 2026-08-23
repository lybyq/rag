# 查询规划与混合检索 面试追问与回答

## 为什么用了 LangGraph，还强调不是 Agent？

LangGraph 是状态图运行时，不等于必须让 LLM 自主选择动作。企业检索的权限、回源和循环上限必须
确定，所以节点和边由代码定义；LLM 只是受限改写节点。

## 为什么不用 Dense 分数和 BM25 分数直接相加？

分数量纲、分布和模型版本不同，直接相加需要持续校准。RRF 只看名次，对尺度不敏感；路线权重仍可
表达业务偏好。它会丢失分数间距，所以 证据与答案生成 还会用专用 Reranker 精排。

## 为什么 Milvus 过滤过权限后还查 PG？

Milvus 是异步投影，权限、归档、生效时间和发布回滚可能在写入后改变。PG 是唯一事实源，回源复核
是防止旧索引泄漏的最后门禁。Milvus Filter 只缩小候选。

## 如何证明没有 N+1？

Repository 把 TopK vectorId 编码成一个 JSONB 参数，用 `jsonb_to_recordset` CTE 与引用、Manifest、
成员、Chunk、版本和文档一次 JOIN，不在循环中按 candidate 调数据库。

## 权限如何进入缓存 Key？

Key 使用 userId、roles、authzVersion、当前允许空间、Profile、Plan 和 query 的摘要。权限变化会 miss。
即使 Redis 返回旧值，PG 仍重新授权，所以缓存不是安全边界。

## 为什么最多两轮？

在线 SLO、成本和可解释性都需要上限。第一轮按原/受控改写查询；不足时第二轮仅确定性放宽。第二轮
仍不足就交给 证据与答案生成 澄清或拒答。代码只有一个回边，配置也强制等于 2。

## 如何应对“LLM 把 v2.1 改成 v2.0”？

改写前提取精确字面量；Zod 校验后检查原始值，遗漏就附加原文精确条件。模型没有 Filter 字段，
最终版本仍由 Manifest 与 PG 成员 JOIN 确认。
