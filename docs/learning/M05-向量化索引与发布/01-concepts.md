# 01｜核心概念：向量写入不等于知识上线

## 1. M05 真正解决什么问题

M04 产出“允许索引的 Child Chunk”，M05 要把它们变成可检索向量，并保证用户永远只看到一套完整版本。难点不在调用一次 Embedding，而在三个系统没有跨库事务：PG 管文档与权限，MinIO 管原文件，Milvus 管向量。

本项目选择 PG `space_manifest_heads` 作为唯一发布开关。Milvus 提前写入候选数据没有关系，只要普通查询必须带 Head 的 `manifest_id`，候选就不可见。

## 2. 五种版本不要混

- documentVersion：业务文件第几版，例如制度 2025/2026 版。
- contentRevision：同一业务文件重新解析、OCR 或分块的修订。
- embeddingRevision：该文档在某个 Manifest 下的向量修订。
- spaceManifestVersion：一个空间完整成员集合的发布快照。
- embeddingProfileId：模型及全部兼容字段的不可变身份。

面试时若只说“加一个 version 字段”，追问一定会落到：文件没变但模型变了怎么办、解析重跑是否覆盖历史、单文档发布会不会让其他文档消失。五层版本就是这些问题的答案。

## 3. Embedding Profile 为什么必须完整

相同模型名不代表相同向量空间。revision、tokenizer、维度、归一化、Sparse 格式、query/document 模板任一变化，都可能使向量不可比较。因此 Profile 不是方便展示的配置，而是 Collection 兼容性契约。

## 4. 为什么 query 与 document 分开

许多检索模型对问题和文档使用不同前缀或模板。把两者做成一个 `embed(text)`，调用者很容易漏传用途，最终离线看似有向量、线上 Recall 却下降。Port 直接拆成 `embedQueries` 与 `embedDocuments`，让错误在编译期暴露。

## 5. 事实复用与来源隔离

相同正文在同一 Profile 下只计算一次 Embedding，键是 `contentSha256 + profileId`。但两个文档的 ACL、页码和引用不能合并，所以 `chunk_embedding_refs` 单独保存每个来源。优化的是模型计算，不是权限事实。

## 6. 对账和发布

发布前至少验证：期望/实际数量、主键缺失与多余、内容 Hash、Profile、固定主键可查询性。通过后才在一个 PG 事务中切换 Head。对账解决“写成功了吗”，Head 解决“用户能看了吗”，二者职责不同。

## 7. Profile rollout

新 Profile 走候选构建和离线评测。FULL 通过后直接原子切换；CANARY 只登记候选和比例，稳定 Head 仍在。稳定 Hash 分桶保证同一 userId 不抖动。请求保存 previous/candidate，所以提升或回退不依赖操作者手写 Collection。
