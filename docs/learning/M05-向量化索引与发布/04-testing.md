# 04｜测试：如何证明“不会把半套索引上线”

## 1. 纯规则测试

- `embedding-batch.spec.ts`：token 分批、并发上限、部分失败重试、背压和取消。
- `manifest-reconciliation.spec.ts`：数量、缺失/多余 PK、Hash、Profile、固定查询。
- `canary-routing.spec.ts`：同一 userId 稳定、样本覆盖两组、100% 伪 CANARY 拒绝。

纯函数测试快，适合先写失败用例再实现规则。

## 2. Provider/Adapter 契约

- HTTP Embedding 覆盖健康、metadata、用途、429、5xx、超时、取消和坏 Schema。
- Milvus Adapter 检查 Collection 字段不含完整正文、维度不兼容拒绝、Filter 不能注入、SDK 取消传播、候选 Manifest 搜索。
- Memory Adapter 只用于 CI，它实现相同 Manifest 隔离与查询语义，但不证明真实 Milvus 性能。

## 3. Application 测试

`indexing.service.spec.ts` 用 Mock Repository + Memory Vector 验证调用顺序：只有 `markVerified` 后才能 publish；复用事实不重复请求模型；对账失败调用 fail。

`index-maintenance.service.spec.ts` 验证 ACTIVE 只补缺失、Hash/Profile 进入人工、重新 ACTIVE 的版本禁止清理、清理失败只重试。

`profile-rollout.service.spec.ts` 验证 Profile 错配终止，以及 Recall 不达标只保存脱敏失败报告。

## 4. 真实 PostgreSQL 集成

`m05-indexing-publication.integration.spec.ts` 是核心证据：

1. 连续发布两个文档，第二个 Manifest 仍有两个成员。
2. 相同正文只有一个 Embedding Fact，但来源成员独立。
3. 向量写入合成中断，Head 完全不变。
4. 历史 Manifest 可一键回滚。
5. 新 Profile 候选评测后登记 20% CANARY，稳定 Head 不变。
6. 提升候选后再按请求回退到起始 Head。
7. 撤权与空间废止产生可靠缓存失效事件。

## 5. 内网必须补什么

单元测试无法证明企业 Milvus 的索引参数、Sparse 格式、分页语义和真实性能，也无法证明内网 Embedding query/document 模板质量。迁入内网后要跑 Provider contract、脱敏 Golden、故障注入、Load/Soak，并保存报告版本与镜像 digest。
