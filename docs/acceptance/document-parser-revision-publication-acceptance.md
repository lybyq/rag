# Parser revision、重处理与原子发布验收

## A. 自动化门禁

- [x] `PARSER_REVISION` 的代码默认值及内网、外网、离线发布环境模板统一为 `1.1.0`。
- [x] HTTP Parser 继续使用 protocol v2，并严格拒绝部署配置与响应 revision 不一致；本次算法变化不要求内网 Provider 修改路径或认证方式。
- [x] derived Block 快照对象 Key 同时包含 `content-r{N}`、Parser Profile 和 Parser revision；`1.0.0` 与 `1.1.0` 不会互相复用。
- [x] Profile/revision 进入对象路径前只允许安全路径段，空值、`.`、`..` 和非法字符不能构造对象 Key。
- [x] Parser 返回的稳定业务错误码经过 HTTP Adapter 后保持原码，例如动画图片仍为 `IMAGE_ANIMATION_UNSUPPORTED`，不会全部退化成 `HTTP_422`。
- [x] 重处理在 PostgreSQL 事务内创建新的 content revision 和 Outbox，旧 Block、Chunk 与解析事实继续保留。
- [x] 质量审核使用 expectedVersion 防并发覆盖；只有审核通过、非重复的 revision 才获得索引资格。
- [x] 索引发布先完成候选构建与对账，再原子切换 PostgreSQL ACTIVE Head；Milvus 构建失败不改变当前 Head。
- [x] 回滚只切换到历史已发布索引版本，不覆盖当前或历史解析事实。
- [x] 文档接入、知识加工和索引发布三组 PostgreSQL 集成测试共 10 项通过。
- [x] 全仓库后端 74 个 Suite/373 项、前端 6 个 Suite/10 项、19 个 Snapshot 通过；TypeScript strict、ESLint、依赖边界、迁移、OpenAPI、六应用生产构建和 Compose 配置门禁通过。
- [x] linux/amd64 六镜像离线包已经重新生成，Manifest 记录 `parserRevision=1.1.0`、六个不可混淆标签和镜像 ID；`verify.ps1` 对 tar、环境模板、Compose、脚本及说明书的 SHA256 校验通过。

## B. 内网升级步骤

1. 部署新镜像，但先不要批量重处理旧文档；检查 Parser `/v1/health/ready` 返回 `revision=1.1.0`、`protocolVersion=2`。
2. 选择一份脱敏的 TXT、CSV、PDF、DOCX、XLSX、PPTX 和图片作为小流量样本，点击“重处理”。每次重处理应创建新的 `contentRevision`，不能覆盖旧 revision。
3. 在解析详情确认 warning、Issue、Block 数、OCR 目标和 derived Key；derived Key 应含 `revision-1.1.0`。
4. 人工完成质量审核后再触发索引。对账通过前 ACTIVE Head 不应改变；失败时线上问答仍读取旧索引。
5. 用同一问题比较新旧引用、召回与答案；确认后原子发布。若质量下降，将 Head 回滚到历史索引版本，并保留新 revision 供排查。
6. 小流量通过后再按知识空间分批重处理；不要在启动脚本中自动把全部历史文档升级。

## C. 回归命令

```powershell
pnpm test:backend -- libs/parser-core libs/application libs/file-processing-providers
pnpm test:integration -- test/integration/document-ingestion.integration.spec.ts test/integration/knowledge-processing.integration.spec.ts test/integration/indexing-publication.integration.spec.ts
pnpm typecheck
pnpm lint
pnpm check:boundaries
```

## D. 不能由外网自动化替代的内网证据

- [ ] 真实 PaddleOCR 对本企业图片方向、中文置信度和 PAGE/EMBEDDED_IMAGE/WHOLE_IMAGE 定位正确。
- [ ] 企业脱敏文档从 `1.0.0` 重处理到 `1.1.0` 后，业务负责人完成质量抽检。
- [ ] 内网 Milvus 候选索引完成数量/Hash 对账，失败注入能证明 ACTIVE Head 不变且可回滚。
- [ ] 分批升级期间完成容量、错误率、积压、人工审核量和 8 小时 soak 验收。
