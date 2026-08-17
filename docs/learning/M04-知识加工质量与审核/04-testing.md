# 04｜测试策略与证据分层

## 1. 为什么需要四层测试

| 层级            | 证明什么                                 | 不能证明什么             |
| --------------- | ---------------------------------------- | ------------------------ |
| 纯函数单测      | 边界、token、关系、质量裁决确定性        | SQL 事务和权限           |
| 契约测试        | 非法 JSON、歧义关系、审核输入被拒绝      | 数据库并发               |
| Golden Snapshot | 代表性结构升级前后是否漂移               | 真实业务文档准确率       |
| PostgreSQL 集成 | Outbox、锁、事务、ACL、revision 真正成立 | 内网 Provider 质量与容量 |

## 2. 当前覆盖

`chunking-core.spec.ts` 覆盖标题/跨页、表格、FAQ、合同、代码、token 上限、去重、来源和质量三态。`review-policy.spec.ts` 覆盖硬拒绝不能批准和终态不可覆盖。Application 测试验证调用顺序与错误落库。

`golden-chunks.spec.ts` 使用五组合成公开样例：标题跨页、多级 Excel 表头、合同条款、FAQ、代码与重复页。Snapshot 只固定可检索字段与关系，不耦合内部临时对象布局；每个 Child 额外断言来源非空和 token 上限。

`m04-knowledge-processing.integration.spec.ts` 使用真实 PostgreSQL 验证：

1. M03 Outbox 能驱动 M04 PASS，合格 Child 才进入待 Embedding；
2. 两个并发审核只有一个成功，无权用户即使直调 Repository 也失败，审核历史不可变；
3. 要求重处理原子创建 revision 2、任务和 Outbox，revision 1 Chunk 仍存在。

Vue 测试按用户可见行为验证质量摘要、发现项和动作入口，不断言组件内部 ref。

## 3. 常用命令

```powershell
$env:TEMP='D:\codex-temp\rag-m04'
$env:TMP='D:\codex-temp\rag-m04'
pnpm jest --runInBand libs/chunking/src/golden-chunks.spec.ts
pnpm test
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm boundary
pnpm build
```

本机 C 盘已满，所以 Node/Jest 临时目录固定在 D 盘。不要为了测试清理用户系统目录。

## 4. 修改算法时怎样更新 Snapshot

先读差异，确认是需求认可的语义变化，再运行：

```powershell
pnpm jest --runInBand libs/chunking/src/golden-chunks.spec.ts -u
```

不能看到 Snapshot 失败就直接 `-u`。需要说明受影响的 Chunk 数量、边界、token、关系和索引资格；若不兼容，应新增 ADR/Profile revision，并以新 content revision 重处理。

## 5. 真实环境仍需补的测试

合成 Block 能证明算法与事务，不代表内网 Parser/OCR 的输入质量。上线前仍要用脱敏业务 Golden 验证标题恢复、复杂表格、扫描 OCR、超长代码/条款，并做中型规模吞吐、Worker kill、并发审核和长时间 soak。
