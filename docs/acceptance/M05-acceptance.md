# M05 验收清单

## A. 自动化功能门禁

- [x] EmbeddingPort 区分 QUERY/DOCUMENT，并支持批量、Deadline、超时和取消。
- [x] Profile 冻结模型、revision、协议、tokenizer、维度、归一化、Sparse 和模板。
- [x] 启动访问 health/metadata，不兼容时 fail-closed。
- [x] Token 动态批次、有限并发、部分失败有限重试和背压。
- [x] Hash + Profile 事实复用，文档来源关系独立。
- [x] 不兼容 Profile 使用 Registry 管理的独立 Collection。
- [x] Milvus Schema 不保存完整正文。
- [x] BUILDING/VERIFIED 候选不进入稳定 Head。
- [x] 数量、主键、Hash、Profile 和固定查询对账。
- [x] PG 事务原子切换 Head 与全部空间成员。
- [x] 发布、废止、撤权、回滚通过 Outbox 触发跨实例缓存失效。
- [x] 构建失败、切换失败和旧 Worker 不改变线上 Head。
- [x] 旧向量延迟清理失败只告警。
- [x] PG/MinIO/Milvus 周期对账具备补写与人工处理策略。
- [x] Profile 候选、离线评测、CANARY、提升和请求级回退自动化闭环。

## B. 工程门禁

- [x] M05 领域/契约/Application/Adapter/Worker/API 均有中文 JSDoc 和需求编号。
- [x] 179 个后端测试通过，M05 新增边界均有自动化断言。
- [x] M01～M05 15 个真实 PostgreSQL/Redis 集成场景通过。
- [x] 真库验证第二次单文档发布仍保留其他空间成员。
- [x] 真库验证 Milvus 合成失败后 Head 不变。
- [x] 真库验证候选评测、20% CANARY、提升和一键回退。
- [x] strict typecheck、ESLint 0 warning、Migration apply/check。
- [x] 最终 format、lint、typecheck、boundary、build、OpenAPI、Migration、Compose 静态门禁。

## C. 内网环境门禁

- [ ] 填写内网 Embedding `/health`、`/metadata`、`/v1/embeddings` Endpoint 和认证。
- [ ] 填写真实 model/revision/tokenizer/dimension/normalize/Sparse/template 并通过启动兼容性检查。
- [ ] 使用企业 Milvus 完成 Schema、索引、分页对账、超时、重启和清理验证。
- [ ] 使用脱敏业务问题集确认 Recall@K，而不是只依赖代表 Chunk 自检。
- [ ] M07 在线检索接入 CANARY 指针并验证 userId 稳定分桶。
- [ ] 中型规模压测、故障注入与至少 8 小时 soak 达标。

## D. 复验命令

```powershell
$env:TEMP='D:\coding\rag\.tmp'
$env:TMP='D:\coding\rag\.tmp'
pnpm db:migrate
pnpm test:backend
pnpm test:integration
pnpm lint
pnpm typecheck
pnpm boundary
pnpm build
pnpm openapi:check
pnpm migration:check
pnpm docker:check
```

若 C 盘已满，不启动会继续向 C 盘写镜像层的 Docker 工作负载；先把 Docker data-root 迁至 D 盘并复核可用空间。
