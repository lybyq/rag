# M03 验收清单

## A. 仓库自动化门禁

- [x] 魔数/MIME/扩展名和流式 SHA/大小交叉验证。
- [x] 内置 Scanner 跨 chunk EICAR、可执行魔数、超限与取消 fail closed。
- [x] 旧外置病毒库 Adapter、TCP 配置、Compose、Volume 和镜像依赖全部删除。
- [x] Node Parser Service 与 PDF/DOCX/XLSX/PPTX/图片/HTML/Markdown/TXT/CSV 真实实现。
- [x] OOXML 内部格式、Zip Slip、宏、ActiveX、嵌入对象、外链、加密、条目和压缩比检查。
- [x] OOXML 重名条目、累计物化内存和 XLSX 远端稀疏单元格 DoS 门禁。
- [x] PNG/JPEG/GIF/TIFF/BMP/WebP 自有有界头解析；无通用图片自动探测攻击面。
- [x] Target 级 OCR 契约；可靠原生文本优先，PAGE 才替换整页，图片/区域只补充。
- [x] `originalText`、稳定 ordinal/ID、页/Sheet/Slide/bbox/table/merged cell 契约。
- [x] derived 版本化路径、SHA metadata 和重试复用。
- [x] retryable/document/developer 三类失败与最大尝试次数。
- [x] 九格式合成 Golden、Block Snapshot 和 Office 恶意结构样本。
- [x] Parser HTTP Schema/protocol/revision/API Key/SSRF 白名单门禁。
- [x] 管理 API、OpenAPI、任务详情 UI 和无密钥 Profile 展示。
- [x] Parser 只读、非 root、cap drop、PID/CPU/内存/tmpfs Compose 静态策略。
- [x] 公网生产依赖审计 critical/high/moderate 均为 0。

## B. 真实内网/预生产门禁

- [ ] 文本/扫描混合 PDF 只 OCR 扫描页。
- [ ] PaddleOCR 能处理 PAGE、Office EMBEDDED_IMAGE 和整图目标，返回 targetId/bbox/confidence/revision。
- [ ] 企业 Excel 合并表头、公式、Sheet 名和单元格规模正确。
- [ ] 企业 PPT 图文顺序、图片区域和 `slideNo` 正确。
- [ ] 企业复杂 PDF 的近似 bbox 能满足页级引用；若要求字形高亮，升级 Adapter 后重验。
- [ ] 密码、损坏、宏、嵌入对象、外链、压缩炸弹走预期状态。
- [ ] Parser 超时/kill 后 lease、有限重试和人工等待正确。
- [ ] MinIO source URL 的容器 DNS/白名单/过期与 derived SHA 复用正确。
- [ ] 企业 SCA/SBOM 通过；若安全制度要求病毒库，接入新的 Scanner Adapter。
- [ ] 中型规模并发和 8 小时 soak 满足资源与错误率目标。

## C. 本地与 Docker 命令

```powershell
$env:TEMP='D:\codex-temp\rag-m03'
$env:TMP='D:\codex-temp\rag-m03'
pnpm test:backend -- libs/document-parser-core apps/document-parser-service libs/file-processing-providers
pnpm build:document-parser-service
pnpm docker:check

# 复制真实配置后启动；Node Parser 使用 8104，可选免费 Docling OCR 使用 8103。
Copy-Item .env.external-dev.example .env.external-dev
docker compose --profile m03 --env-file deploy/docker/images.external.env `
  -f deploy/docker/docker-compose.yml -f deploy/docker/docker-compose.apps.yml up -d --build
Invoke-RestMethod http://localhost:8104/v1/health/ready
```

执行镜像构建前必须确认 Docker data-root 位于有空间的数据盘；当前项目 TEMP/TMP 和 Parser 相对目录均应落在 D 盘。
