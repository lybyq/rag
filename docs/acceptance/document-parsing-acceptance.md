# 文件解析与OCR 验收清单

## A. 仓库自动化门禁

- [x] 魔数/MIME/扩展名和流式 SHA/大小交叉验证。
- [x] 内置 Scanner 跨 chunk EICAR、可执行魔数、超限与取消 fail closed。
- [x] 旧外置病毒库 Adapter、TCP 配置、Compose、Volume 和镜像依赖全部删除。
- [x] Node Parser Service 与 PDF/DOCX/XLSX/PPTX/图片/HTML/Markdown/TXT/CSV 真实实现。
- [x] OOXML 内部格式、Zip Slip、宏、ActiveX、嵌入对象、外链、加密、条目和压缩比检查。
- [x] OOXML 重名条目、累计物化内存和 XLSX 远端稀疏单元格 DoS 门禁。
- [x] PNG/JPEG/GIF/TIFF/BMP/WebP 自有有界头解析；无通用图片自动探测攻击面。
- [x] Target 级 OCR 契约；可靠原生文本优先，PAGE 才替换整页，图片/区域只补充。
- [x] OCR 空、缺失、重复、额外、错位、低置信和部分成功有独立结果；不可用 PAGE 保留原生内容并停在人工审核。
- [x] OCR Provider 目标能力可通过 `OCR_CAPABILITIES` 收窄；PPTX 不再由字符覆盖率误生成通用 PAGE 目标。
- [x] OCR 质量审核事务保存 Block/Issue/快照和低基数结果计数，且不会投递 CHUNK Outbox。
- [x] `originalText`、稳定 ordinal/ID、页/Sheet/Slide/bbox/table/merged cell 契约。
- [x] derived 版本化路径、SHA metadata 和重试复用。
- [x] retryable/document/developer 三类失败与最大尝试次数。
- [x] 九格式合成 Golden、Block Snapshot 和 Office 恶意结构样本。
- [x] Parser HTTP Schema/protocol/revision/API Key/SSRF 白名单门禁。
- [x] 九格式统一资源预算在扩容前检查，超限不截断；同步解析由可终止 Worker 隔离并限制并发。
- [x] Parser 输出字符、真实/展开表格单元格和像素使用低基数 Prometheus 指标。
- [x] HTML/Markdown 按 DOM 阅读顺序保留裸文本、br、代码、引用和层级列表，且不重复父子正文。
- [x] HTML 表格补齐尾部跨度并隔离嵌套表，所有 merged cell 坐标落在矩阵内。
- [x] XLSX 图片用真实 media index/name 关联字节，覆盖 imageId=0、image10、重复与非连续媒体名。
- [x] XLSX 多区域、源行列、合并、公式缓存状态和关键显示格式可回溯。
- [x] PPTX 按 presentation relationship 恢复重排后的真实页序，同段 Run、母版标题、组合坐标和合并表格可回溯。
- [x] PPTX 备注、图表、SmartArt、隐藏页和复杂旋转不静默丢失，均返回稳定告警或明确近似语义。
- [x] DOCX 图片按 drawing relationship 和正文 occurrence 关联；重复资产不合并出现位置，OCR 结果紧跟对应图片锚点。
- [x] DOCX 不伪造物理页码/bbox，自定义 outline 标题、嵌套列表、合并表格和边界能力有回归或告警。
- [x] PDF TextItem 字号/字体/真实坐标、行段、双栏、跨页连续和可解释标题进入统一 Block 与 Chunking 标题路径。
- [x] PDF 重复页眉页脚、旋转、矢量表格去重、扫描/混合/空白/短文字页和附件/动作检查有回归。
- [x] TXT 严格处理 UTF-8/UTF-16 BOM、非法编码和 CRLF/LF/CR；空白行分段并保留原始换行，不臆造标题。
- [x] CSV 分隔符、引号/跨行字段、保守表头推断、空记录与不规则列有可审计事实，真实/展开单元格分别受限。
- [x] 图片完整枚举页/帧并累计像素；多页 TIFF/动画明确拒绝，EXIF/TIFF 方向未应用时明确告警。
- [x] Parser revision 统一升级为 `1.1.0`，derived Key 按 content revision、Profile 和 Parser revision 三重隔离，旧快照不能跨版本复用。
- [x] 重处理保留旧解析事实，质量审核后才进入索引；候选索引对账后原子切换 ACTIVE Head，构建失败不切换且历史版本可回滚。
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
$env:TEMP='D:\codex-temp\rag-document-parsing'
$env:TMP='D:\codex-temp\rag-document-parsing'
pnpm test:backend -- libs/document-parser-core apps/document-parser-service libs/file-processing-providers
pnpm build:document-parser-service
pnpm docker:check

# 复制真实配置后启动；Node Parser 使用 8104，可选免费 Docling OCR 使用 8103。
Copy-Item .env.external-dev.example .env.external-dev
docker compose --profile document-parsing --env-file deploy/docker/images.external.env `
  -f deploy/docker/docker-compose.yml -f deploy/docker/docker-compose.apps.yml up -d --build
Invoke-RestMethod http://localhost:8104/v1/health/ready
```

执行镜像构建前必须确认 Docker data-root 位于有空间的数据盘；当前项目 TEMP/TMP 和 Parser 相对目录均应落在 D 盘。
