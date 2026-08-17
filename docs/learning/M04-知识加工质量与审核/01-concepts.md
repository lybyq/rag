# 01｜核心概念：从 Block 到可发布知识

## 1. M04 在整条 RAG 链路里的位置

M03 的 `DocumentBlock` 是“解析事实”：它回答原文件有哪些标题、段落、表格、页码和坐标。M04 的 `KnowledgeChunk` 是“检索策略产物”：它回答应该把哪些上下文一起送去向量化、哪些内容只能展示、以及一段知识从哪里来。

二者必须分开。Parser/OCR 很贵，而 Chunk 长度、标题继承、去重和质量规则会持续迭代。分开后，Chunker 升级只需创建新 `contentRevision`，不必覆盖旧解析事实，也不会让已发布引用突然无法复现。

## 2. 为什么不能按固定字符数切分

“每 500 字切一刀”会制造四类典型错误：

- 标题和正文分离，检索到正文却不知道适用章节；
- 合同条款、FAQ 问答和代码函数被从中间切断；
- 表格后半段失去多级表头，数值不再有列语义；
- 中文、英文、代码的字符数与模型 token 数关系完全不同。

本项目先从 Block 恢复标题路径和语义边界，再按 `TABLE/CODE/FAQ/CLAUSE/SLIDE/SHEET/PROSE` 选择策略，最后用真实 BPE Tokenizer 校验最终 `embeddingText` 的硬上限。

## 3. Parent、Child 与显式关系

Child 尺寸较小，用于精确检索、排序和引用；Parent 聚合同一章节内的若干 Child，用于命中后的上下文扩展。二者不靠字符串猜测关联，而是保存 `PARENT_CHILD` 关系。

同时保存：

- `PREVIOUS/NEXT`：命中段落的前后邻居；
- `SOURCE_BLOCK`：回到 M03 原始 Block、页码、Sheet、Slide 和 bbox；
- `TABLE_HEADER`：表格分段后仍能找回表头；
- `FOOTNOTE`：正文与脚注关系；
- `DUPLICATE_OF`：重复内容的原始出处不丢失。

显式关系是可审计 RAG 的基础。后续 M08 展开上下文时可以逐条重新鉴权，而不需要相信一段拼接文本。

## 4. displayContent 与 embeddingText

`displayContent` 尽量保持用户可读原文，用于引用预览。`embeddingText` 会补入标题路径等检索上下文，用于 Embedding。两者分开可以同时避免两个极端：为了向量效果污染引用原文，或为了原样展示而让脱离标题的正文语义不完整。

Chunk 保存 `tokenizerProfileId/tokenizerRevision/tokenCount`。当前外网实现使用 `js-tiktoken` 的 `cl100k_base` 真实 BPE，不用字符数估算；接入内网 Embedding 后应换成与该模型完全一致的 Tokenizer，并以新 profile/revision 重处理，不能原地改写历史计数。

## 5. 可逆去重

去重不是删除。系统对规范化内容计算 SHA-256，将重复 Child 标成 `RETAINED_DUPLICATE` 或 `SUPPRESSED_DUPLICATE`，并用 `DUPLICATE_OF` 指向第一份内容。`SUPPRESS` 只取消后续索引资格，原 Chunk、页码和关系仍留在 PostgreSQL，因此审核者仍能回答“哪些页面重复、为什么没进索引”。

## 6. 三态质量门禁

质量结论不是一个模糊分数，而是三态 Policy：

- `PASS`：自动规则通过，可以把非重复 Child 交给 M05；
- `MANUAL_REVIEW`：存在可判断但机器不能安全放行的问题，必须等待有 `REVIEW` 权限的人；
- `REJECT`：缺页、版本冲突等硬阻断，不允许人工直接批准绕过。

报告保存规则版本、指标和发现项。审核状态与自动结论分列保存，避免“人工批准”抹掉机器当时发现的问题。

## 7. 并发审核与 revision

审核请求必须带 `expectedVersion` 和原因。PostgreSQL 在事务中锁定报告行并检查乐观版本；两个人同时看到 v1 后提交，只有第一个能成功，第二个得到 409，必须重新加载事实。

“要求重处理”不是清空旧结果，而是在同一事务中：创建新 `contentRevision`、新任务步骤和 Outbox 事件。旧 revision 继续保留，直到未来生命周期策略确认已无发布引用后安全清理。
