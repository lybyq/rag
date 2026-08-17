# 06｜面试追问与落地回答

## Q1：为什么 Block 和 Chunk 要分层？

Block 是 Parser/OCR 产生的可定位事实，Chunk 是可迭代的检索策略。分层后 Chunker、Tokenizer 或质量规则升级只创建新 revision，不必重跑昂贵解析，也能复现历史引用。错误做法是 Parser 直接输出最终 Chunk，导致解析与检索耦合。

## Q2：为什么不用固定字符切分？

字符数不等于模型 token，且会破坏标题、条款、FAQ、代码和表格边界。当前实现先恢复结构，按内容类型选策略，再用真实 BPE 对最终 embeddingText 校验硬上限。测试覆盖中文、表格和长代码。

## Q3：Parent-Child 解决什么问题？

小 Child 提高召回和定位精度，Parent 在命中后补足章节上下文。只存 Parent 会召回粗糙，只存 Child 会语义不完整。当前通过显式关系连接，后续扩展 Parent 时还可以重新做权限和版本检查。

## Q4：表格怎么切才不会让数字失去含义？

按行组切，不跨表格边界，每个分段重复多级表头，并保留合并单元格元数据、Sheet 和来源 Block。错误做法是把 Markdown 表格当普通字符流，后半段只剩数字。Golden 固定多级表头输出。

## Q5：Token 上限是怎样保证的？

不是 `字数/4`，也不是只算正文。使用固定 revision 的真实 BPE；正文初切后再拼标题路径，对完整 embeddingText 重计数，不满足就收紧预算。Golden 曾抓到 65 超过 64 的边界并推动修复。

## Q6：为什么去重不能直接删行？

重复页本身也是文档事实，审核、合规和引用需要知道它出现在哪里。系统保留 Chunk 与来源，用 hash、dedup status 和 `DUPLICATE_OF` 表达；SUPPRESS 只影响索引资格。测试验证跨页重复仍保留两份来源。

## Q7：PASS、MANUAL_REVIEW、REJECT 为什么不能合成分数？

分数难表达硬约束。版本冲突或严重缺页必须阻断，不能被其他高分抵消；OCR 较低等问题可以人工判断。三态 Policy 把路由语义固化，报告保存规则版本、指标与原因。错误做法是 `score > 0.6` 一刀切。

## Q8：人工审核怎么防并发覆盖？

请求携带 expectedVersion；事务 `FOR UPDATE` 锁报告并校验版本，成功后版本加一，同时追加不可变审核和审计。两人并发只有一个成功，另一个 409 后刷新。集成测试用真实 PostgreSQL 验证 exactly-one-winner。

## Q9：管理员能否批准自动 REJECT？

不能直接批准。硬 REJECT 代表 Policy 的确定性阻断，人工只能拒绝或要求重处理；否则权限较大的用户可以绕过缺页/版本冲突。这个规则位于纯 review policy，不依赖某个 UI 是否隐藏按钮。

## Q10：如何保证未审核内容进不了 Milvus？

资格是 PostgreSQL 事实：MANUAL_REVIEW/REJECT 的 Chunk 为 false；合法批准才在同一事务中开放允许的 Child。M05 只能查询 eligible rows，不能让消息或前端参数声明“已通过”。SUPPRESSED_DUPLICATE 即便报告通过也保持 false。

## Q11：重处理为什么创建新 content revision？

原地覆盖会让线上引用、审计报告和索引无法复现。当前事务创建新 revision、Job Steps 和 Outbox，旧 Chunk 保留；切换与安全清理由后续发布 Manifest 和生命周期负责。集成测试同时断言 revision 2 已创建且 revision 1 仍存在。

## Q12：如何替换成内网 Embedding Tokenizer？

实现相同 `TextTokenizer` Port，返回不可变 profileId/revision，并配置注入。切换后创建新 Chunker/Tokenizer Profile 和 content revision，跑 Golden 与检索评测；不能直接改 `cl100k` 的历史含义。当前 cl100k 是外网可运行基线，不宣称与 DeepSeek 或内网 Embedding 精确一致。

## Q13：旧 Worker 网络恢复后会不会覆盖结果？

不会只靠消息幂等。begin、complete、fail 的数据库写入都校验 job RUNNING、lease owner 和过期时间；租约丢失的 Worker 无法提交。这是数据库 fencing，解决“两个合法执行者先后返回”的竞态。

## Q14：你如何证明这不是 Demo？

证据要分层：严格类型/Lint/边界、107 后端与 7 前端测试、5 类 Chunk Golden、真实 PG 的 Outbox/ACL/并发/revision 集成、Migration/OpenAPI/构建/依赖审计。也要诚实说明仍需在 D 盘 Docker 或预生产补 MinIO/Milvus、内网 Parser/OCR/Tokenizer 和容量 soak，不能拿合成数据冒充真实质量。
