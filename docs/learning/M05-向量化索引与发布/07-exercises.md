# 07｜练习与自检

## 练习 1：画发布时序

不看代码画出 M04 PASS 到 Head 切换的顺序，并标出三个“失败但旧版仍在线”的位置。完成后对照 `IndexingService.process()` 和 `publish()`。

## 练习 2：解释版本

给出以下变化分别应该改变哪个版本：上传新制度、OCR 参数重跑、只升级 Embedding revision、单文档发布、query 模板变化。要求说明为什么不能覆盖旧值。

## 练习 3：设计部分失败用例

构造 5 个 Embedding 输入，让第 2/4 项第一次返回 429，第二次第 4 项返回坏 Hash。写出最终成功、失败和调用批次；再在 `embedding-batch.spec.ts` 实现测试。

## 练习 4：验证不可见候选

在本地跑 M05 集成测试，暂停在 `markVerified` 后查询 Milvus/Memory 候选和 PG Head。回答为什么“向量存在”和“用户可检索”不是同一事实。

## 练习 5：故障注入

分别让向量写入、对账、PG publish 抛错，断言 Head 都不变。思考哪一种会留下 Milvus 垃圾，应该由谁清理。

## 练习 6：Profile 兼容性

复制一个 Profile，只改变 tokenizerRevision、normalizeDense 或 documentTemplateVersion，预测 Registry/Collection 行为。不得用原 profileId 修改历史含义。

## 练习 7：灰度并发

创建 CANARY 候选后先发布另一个文档，再尝试 promote。解释为什么应得到 409，以及怎样重建才不会丢失新文档。

## 练习 8：内网接入清单

向内网模型团队索要并记录：health、metadata、认证、TLS、model/revision、tokenizer、维度、归一化、Sparse 格式、query/document 模板、最大输入、最大 batch、限流语义。把答案映射到 `.env.intranet-staging`，但不要提交密钥。

## 自检标准

你应能在白板上解释：为什么 PG 是发布事实源、Manifest 如何保持空间完整、事实复用为何不越权、对账各检查解决什么故障、Profile 变化为何新建 Collection、CANARY 如何稳定路由，以及内网哪些证据不能由外网 Fixture 替代。
