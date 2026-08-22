# ADR-011：自有 Node 多格式 Parser 与内置内容安全预检

## 状态

Accepted，2026-08-22。取代 ADR-008 中“外置病毒库服务是默认扫描器”和“Docling 是默认 Parser”的部分；ADR-008 的隔离 Bucket、端口边界、按需 OCR、统一 Block 和派生快照结论继续有效。

## 背景

最终系统必须离线带入企业内网。内网会提供 PaddleOCR、LLM、Embedding、Reranker 和 Milvus，但不会提供项目所需的多格式 Parser。只保留 `ParserPort` 和 Docling Adapter 无法交付真实的 DOCX/XLSX/PPTX/HTML/Markdown/TXT/CSV/图片解析，也无法证明 OOXML 内部格式、宏、外链、嵌入对象和压缩比例已经检查。

用户确认内网不部署额外病毒库服务。简单代码无法拥有持续更新的病毒特征库，因此必须同时做到两点：删除该服务的运行与镜像依赖；诚实限定替代能力，不能把规则未命中表述为“已完成商业杀毒”。

## 决策

1. 新增独立 NestJS 应用 `apps/document-parser-service`，默认监听 `8104`，对外提供 `POST /v1/parse`、健康和指标。解析算法不进入 `ingestion-worker`。
2. 新增 `libs/document-parser-core` 和封闭 `ParserRegistry`，真实支持 PDF、DOCX、XLSX、PPTX、图片、HTML、Markdown、TXT、CSV。所有结果最终再次通过 `ParserResultSchema`。
3. Office 文件先由 `safe-ooxml.ts` 读取 central directory 和 entry 流：拒绝路径穿越、重复条目混淆、加密、条目风暴、单项/累计物化超限、过高压缩比和格式内部事实不匹配；记录宏、ActiveX、嵌入对象、外链、压缩大小与深度。嵌入对象永不执行。
4. PDF 采用 `pdf-parse`（内部封装 `pdfjs-dist`）提取逐页原生文本、链接和矢量表格，不引入 Canvas Native Addon。当前库不公开字形 bbox，Block 只提供明确标注为 `APPROXIMATE_LINE_ORDER` 的页内近似定位；不能将其宣传成像素级字形坐标。
5. OCR 协议升级为 `OcrTarget[]`。PDF 使用 PAGE，图片使用 WHOLE_IMAGE，Office 归档内图片使用 EMBEDDED_IMAGE；HTML/Markdown 外部图片默认不抓取。只有整页 OCR 可以替换低可靠原生页，区域/图片 OCR 只能补充。
6. 删除旧外置扫描 Adapter、TCP 配置、Compose Service、Volume 和镜像清单。默认 `builtin` Scanner 流式识别 EICAR 验收串、PE/ELF/Mach-O/Shebang 魔数和文件上限，支持跨 chunk 匹配、Abort 和稳定 revision。
7. 内置 Scanner 的 Profile 能力显式包含 `NO_SIGNATURE_DATABASE`。Office 活动内容和压缩安全由 Parser 检查；主机/容器镜像漏洞由企业 SCA/SBOM 和部署平台负责。若未来安全基线要求完整反恶意软件能力，应新增独立 Scanner Adapter，不修改应用层。
8. Parser 下载只允许 `PARSER_ALLOWED_SOURCE_HOSTS` 精确白名单，拒绝 URL 用户信息与 HTTP 重定向，响应流受 `PARSER_MAX_INPUT_BYTES` 和 Deadline 限制。预签名 URL 不进入日志和数据库。
9. 外网和内网默认都使用同一 Node Parser HTTP 契约；Docling Adapter 继续保留为可选兼容/免费 OCR 路径，但不再是生产 Parser。
10. 图片尺寸不使用拥有额外格式处理器的通用探测依赖。项目自有有界头解析器只接受平台已放行的 PNG/JPEG/GIF/TIFF/BMP/WebP；每次偏移读取先验边界，JPEG/TIFF 循环受文件长度限制。生产依赖审计发现的图片无限循环 DoS 因移除该依赖而关闭。

## 取舍

- 自有 Parser 提升可控性、离线可部署性和安全事实完整度，同时也意味着项目必须维护格式兼容 Golden、依赖漏洞和解析质量回归。
- 自有图片头解析减少供应链和无关格式攻击面，但支持新图片格式必须显式实现、测试并升级 Parser revision，不能由第三方库静默扩大能力。
- 256 MiB 默认输入上限低于平台 2 GiB 上传上限。超大文件会被明确拒绝 Parser，而不是把 Node 堆耗尽；真实容量评测后可按 Profile 调整或增加受控离线大文件流程。
- PDF 当前 bbox 为页内近似定位。这足以完成页级引用和 OCR 决策，但若合同审计要求字形级高亮，应新增基于 pdfjs TextItem 的 ESM/独立进程 Adapter，并用新 Parser revision 重建内容。
- 不部署外置病毒库服务减少镜像、特征库更新和 TCP 服务运维，但降低了未知恶意样本检出能力。该风险必须由内网上传来源控制、容器隔离、SCA 和未来可插拔企业扫描服务共同承担。

## 验证

- 真实合成格式 Golden：TXT、CSV、HTML、Markdown、PNG、PDF、DOCX、XLSX、PPTX。
- Office 安全样本：内部格式错配、宏、嵌入对象、外链和高压缩比。
- Scanner 样本：跨 chunk EICAR、PE 魔数、取消和大小上限。
- HTTP 契约：Schema、协议版本、revision、共享密钥、SSRF 主机白名单。
- Docker 静态门禁：Parser 只读根、非 root、cap drop、PID/CPU/内存/tmpfs、处理网络。
