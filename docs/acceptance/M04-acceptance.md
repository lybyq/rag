# M04 验收清单

## A. 自动化功能门禁

- [x] 标题树、段落、列表、脚注、跨页阅读顺序恢复。
- [x] 表格、代码、条款、FAQ、PPT/Sheet 与普通正文采用结构化策略。
- [x] Parent/Child、前后邻居、表头、脚注、来源和重复关系可追溯。
- [x] displayContent 与 embeddingText 分离。
- [x] 真实 BPE 计算最终 embeddingText，超长 Child 不超过硬上限。
- [x] 页内/跨页重复可逆抑制且不删除来源。
- [x] 覆盖、OCR、结构、乱码、重复、缺页、表格、负责人和版本质量规则。
- [x] PASS/MANUAL_REVIEW/REJECT 保存规则版本、指标与发现原因。
- [x] 无 REVIEW 权限拒绝，审核必须有原因和 expectedVersion。
- [x] 并发审核只有一个成功，硬 REJECT 不能直接批准，审核历史不可变。
- [x] 未通过门禁、Parent 与 SUPPRESSED_DUPLICATE 不具备索引资格。
- [x] 重处理新建 revision/job/outbox，旧 Chunk 保留。
- [x] 5 类 Golden Snapshot 与 10/10 关键字段准确率通过。
- [x] API、OpenAPI、管理台 loading/empty/error/retry/403/409/取消状态通过静态和组件门禁。

## B. 工程门禁

- [x] format、ESLint 0 warning、strict typecheck、依赖边界。
- [x] 108 后端和 7 前端测试。
- [x] M04 三个真实 PostgreSQL 集成场景。
- [x] Migration、OpenAPI、Compose 静态配置、五应用生产构建。
- [x] 生产依赖 high audit 无已知漏洞。
- [x] M04 指标不使用敏感或高基数标签。

## C. 真实环境/跨模块门禁

- [ ] 内网 Embedding 官方 tokenizer 与固定模型 revision 完成兼容性验证。
- [ ] 脱敏业务 Golden 对复杂表格、合同、FAQ、代码和扫描件达到评审阈值。
- [ ] D 盘 Docker 环境的 MinIO/Milvus `infra-health` 全部 up。
- [ ] M05 验证只有 eligible Child 写入构建索引，未发布数据在线不可见。
- [ ] 中型规模吞吐、Worker kill、并发审核和至少 8 小时 soak 达标。

## D. 复验命令

```powershell
$env:TEMP='D:\codex-temp\rag-m04'
$env:TMP='D:\codex-temp\rag-m04'
pnpm db:migrate
pnpm test
pnpm test:integration
pnpm lint
pnpm typecheck
pnpm boundary
pnpm build
pnpm openapi:check
pnpm migration:check
pnpm security:audit
```

当前 C 盘已满。启动完整基础设施前先确认 Docker data-root 和临时目录位于 D 盘；不得通过清理未知用户文件腾空间。
