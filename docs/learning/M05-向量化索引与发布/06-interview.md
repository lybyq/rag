# 06｜面试追问与参考回答

## 1. 为什么 Milvus 写成功不能直接上线？

因为 Milvus 与 PG 没有跨库事务，批次也可能部分成功。我们让所有行带 manifest_id，写完做完整对账，最后只在 PG 事务里切 Head。失败时候选仍存在，但查询拿不到它的 manifest_id，所以不可见。

## 2. 单独发布一个文档，其他文档为什么不会消失？

创建新 Manifest 时先复制当前 Head 的全部成员，排除目标 documentId，再插入目标新版本。最终 Manifest 仍是空间完整快照。真实 PG 集成测试断言第二次发布成员数为 2。

## 3. 如何处理 Embedding 部分失败？

批次响应按 itemId 与 contentSha256 对齐；成功项保留，只重试明确 retryable 的失败项，漏项视为 Schema 错误。有限次数后仍失败就关闭候选，不切 Head。

## 4. 为什么按 Hash 复用不会越权？

复用的是数值向量事实，不是来源。Chunk→Fact、文档成员、ACL 和引用定位分别保存。检索先用空间/Manifest 过滤，再回 PG 校验来源权限。

## 5. 为什么不能只用 Milvus Alias？

Alias 切换不与 PG 的文档成员、任务状态、审计和 Outbox 同事务。我们的 Alias 只解决 Profile 到物理 Collection 的寻址；业务版本由 PG Head 决定。

## 6. 对账为什么还要固定查询，数量相同不够吗？

数量相同只能证明行数，不能证明索引已加载或特定主键可查。固定主键查询能捕获“数据写了但查询路径坏了”。Hash/Profile 则捕获写到了错误语义空间。

## 7. 新模型如何灰度？

新 Profile 建独立 Collection 和 VERIFIED 候选，query 端点对候选做离线自检。CANARY 只登记稳定/候选/比例/salt，不改稳定 Head；M07 用 userId 稳定 Hash 分桶。确认后 promote 原子切 Head，异常按请求记录的 previous Manifest 回退。

## 8. rollout 期间又有人发布文档怎么办？

提升时比较当前 Head 是否仍等于 rollout 起点。不同就返回 409，因为候选基于旧成员快照，强行提升会覆盖新文档。正确动作是基于最新 Head 重新构建。

## 9. 维护任务为什么不自动修所有异常？

缺失 PK 可以从 PG + Embedding Fact 无损补写。Hash/Profile 错误意味着语义可能错，自动删除重写 ACTIVE 数据风险更高，所以进入人工处理。自动化要有安全边界。

## 10. 外网 Fixture 有什么价值和局限？

它能稳定验证状态机、事务、幂等、失败路径和 API，不依赖公网或个人密钥；不能证明 Recall、真实 Milvus 行为和内网吞吐，因此环境验收单独保留未完成项。
