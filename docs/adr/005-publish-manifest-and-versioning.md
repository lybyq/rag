# ADR-005：发布 Manifest 与版本化

- 状态：Accepted
- 日期：2026-08-15
- 关联需求：IDX-007～IDX-015、CFG-011

## 背景

同一批文档可能经历不同解析器、Chunk、Embedding 和索引配置。仅保存 collection 名称，无法证明一次回答检索的是哪套知识，也无法安全回滚。

## 决策

每次发布生成不可变 Manifest，记录文档版本集合、解析/Chunk Profile、Embedding/Reranker 版本、向量维度、Collection 与创建时间。在线别名只指向一个已完成 Manifest；切换使用发布 Saga，旧 Manifest 在保留期内可回滚。契约和事件采用显式版本，新增字段保持向后兼容。

## 备选方案

- 原 Collection 原地覆盖：资源省，但中间态可见且难以回滚。
- 只记录模型名称：无法复现切分、过滤和数据版本。

## 结果

回答、评测和事故都能定位到精确知识版本。代价是额外存储与垃圾回收流程，M05 实现。
