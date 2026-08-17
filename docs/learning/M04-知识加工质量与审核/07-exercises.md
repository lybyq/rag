# 07｜动手练习

每个练习都先写失败测试，再改实现；不要直接更新 Snapshot 掩盖回归。

## 练习 1：跟踪一个跨页章节

在 `chunking-core.spec.ts` 增加三级标题和跨三页正文。断言 headingPath、Parent/Child、PREVIOUS/NEXT 和 SOURCE_BLOCK。然后逐步调试 `restoreDocumentStructure -> buildChildCandidates -> createDraft`。

验收：能解释为什么 pageNo 变化不必然切断章节，以及什么边界必须切断。

## 练习 2：接入内网 Tokenizer

实现一个新的 `TextTokenizer` Adapter，配置 profile/revision，使用内网 Embedding 模型官方 tokenizer。增加正常、超时、取消、Schema 漂移和版本不匹配测试；远程实现必须支持 Deadline 与 AbortSignal。

验收：同一文本在 cl100k 与内网 tokenizer 下产生不同计数时，以新 content revision 保存，旧 Run 不变化。

## 练习 3：扩展表格策略

增加“表头自身超过 child 上限”和“单行超长单元格”样例。设计怎样既遵守 token 上限又明确标记 header 是否完整，不能静默输出无语义数字。

验收：每个 TABLE Child 可定位、不过限、有表头关系；无法安全处理时进入明确质量发现项。

## 练习 4：制造审核竞态

运行 M04 PostgreSQL 集成测试，在两个 Promise 提交前打断点，观察行锁和 optimisticVersion。尝试删除行锁或版本检查，看为何会出现覆盖。

验收：能用时间线解释 exactly-one-winner，而不是只说“数据库保证”。

## 练习 5：新增质量规则

例如增加“连续超短 Child 比例”规则。需要同时修改 config、类型、纯 Policy、finding code、Golden/单测、报告展示、文档和 rule version。

验收：硬拒绝与人工复核阈值不倒置；历史报告不被当前配置重新计算。

## 练习 6：做一次故障演练

在 M04 处理到 Chunk 后主动终止 Worker，等待 lease 过期并让新 Worker 接管。观察旧 Worker 恢复后提交被拒绝，且数据库只保留一套有效结果。

验收：记录 job、lease owner、run、inbox/outbox、最终状态和指标，证明没有重复事实。

## 练习 7：准备面试白板

不看代码画出 M03 Outbox 到 M04、三态门禁、审核和 M05 的链路，并标出四个事务边界、两个权限检查、一个乐观锁和一个 lease fencing。

验收：在五分钟内回答“为什么不是直接切字符串并写 Milvus”。
