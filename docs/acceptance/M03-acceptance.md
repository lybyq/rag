# M03 验收清单

## A. 自动化门禁

- [x] 魔数/MIME/扩展名和流式 SHA/大小交叉验证。
- [x] ClamAV INSTREAM、Parser/OCR HTTP 契约和 Zod fail closed。
- [x] 宏、密码、嵌入对象、外链、压缩、页、像素、表格限制策略。
- [x] 低覆盖页 OCR，可靠文本页不被覆盖。
- [x] `originalText`、稳定 ordinal/ID、页/Sheet/Slide/bbox/table 契约。
- [x] derived 版本化路径、SHA metadata 和重试复用。
- [x] retryable/document/developer 三类失败与最大尝试次数。
- [x] 九格式 Golden 路由和 Block Snapshot。
- [x] 管理 API、OpenAPI、任务详情 UI 和无密钥 Profile 展示。
- [x] Compose 隔离策略静态校验。

## B. 真实环境门禁（当前机器因 C 盘无空间未执行）

- [ ] EICAR 被真实 ClamAV 拒绝，扫描异常不会放行。
- [ ] 文本/扫描混合 PDF 只 OCR 扫描页。
- [ ] Excel 合并表头、Sheet 名和单元格规模正确。
- [ ] PPT 图文顺序和 `slideNo` 正确。
- [ ] 复杂 PDF/图片 bbox 可回到原页，低置信页产生告警。
- [ ] 密码、损坏、宏、嵌入对象、外链、压缩炸弹走预期状态。
- [ ] Parser 超时后容器任务被终止，lease/重试/人工等待正确。
- [ ] MinIO derived 对象 Hash 相同重试复用，Hash 不同不静默误用。
- [ ] 中型规模并发和 8 小时 soak 满足资源与错误率目标。

## C. 真实验收命令模板

```powershell
$env:TEMP='D:\codex-temp\rag-m03'
$env:TMP='D:\codex-temp\rag-m03'
docker compose --profile m03 --env-file deploy/docker/images.env -f deploy/docker/docker-compose.yml up -d clamav docling
pnpm db:migrate
pnpm test:integration
pnpm check
```

执行前必须确认 Docker data-root 在有足够空间的数据盘；不要在当前已满的 C 盘直接拉取 Docling。
