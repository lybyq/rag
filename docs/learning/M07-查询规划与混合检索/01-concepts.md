# M07 概念：企业检索不是一次向量搜索

## M07 解决什么问题

文档已经切块并写入 Milvus，只代表“有可搜索的数据”。在线问答还必须回答四个问题：

1. 这句话是问候、知识问题、需要澄清，还是越权请求？
2. 金额、日期、版本和编号是否在改写中原样保留？
3. Dense、Sparse 返回的不同分数如何公平融合？
4. 命中的记录现在是否仍有权限、仍属该 Manifest、仍有效？

因此 M07 输出的不是答案，而是一组经过当前事实复核的 `RetrievalCandidate`。答案、引用和拒答在 M08。

## 为什么 Dense + Sparse

Dense 擅长语义近似，例如“报消”错别字和“HR BP”缩写；Sparse 擅长编号、术语和精确关键词。
两类分数不可直接相加。RRF 只使用名次：

`score(d) = Σ routeWeight / (rrfK + rank(route,d))`

这让分数量纲不再影响融合。缺失一路不会给零分惩罚；重复主键在同一路只采用最佳名次。

## 为什么必须 PG 回源

向量库是索引，不是授权和版本事实源。索引写入后，文档可能被归档、权限可能撤销、Manifest 可能
被回滚，或制度尚未到生效日期。M07 只把 Milvus 的 `vectorId` 当候选线索，最终正文和可见性由
PostgreSQL 单次批量查询确认。

## LangGraph 在哪

真正的图位于 `libs/rag-graph/src/m07-retrieval.graph.ts`。它不是架构图或未来占位：

- `StateSchema` 定义节点共享状态；
- `StateGraph.addNode/addConditionalEdges` 定义流程；
- `compile()` 检查图；
- `invoke()` 执行一次检索；
- `retry_plan → query_embedding` 是唯一回边，最多进入一次。

M06 是“运行容器”，M07 是“检索子图”，M08 会成为“生成与校验主图”。
