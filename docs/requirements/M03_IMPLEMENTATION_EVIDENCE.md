# M03 文件安全、Node Parser 与 OCR：实施证据

> 更新日期：2026-08-22。本文严格区分“仓库可自动证明的实现”与“必须进入真实内网才能补跑的 Provider/容量证据”。

## 1. 需求映射

| 需求    | 主要实现                                                                               | 自动化证据                                                  |
| ------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| PAR-001 | `file-detection.ts`、流式 SHA/大小、quarantine/derived 分离                            | 伪装 PDF、Office ZIP、对象 Hash 测试                        |
| PAR-002 | `MalwareScannerPort`、`BuiltinContentSafetyScannerAdapter`、Fixture                    | 跨 chunk EICAR、PE 魔数、字节上限/取消                      |
| PAR-003 | `safe-ooxml.ts`、`image-dimensions.ts`、`security-policy.ts`、各格式 inspection        | 格式错配、重复/加密条目、宏、外链、压缩/稀疏表、页/像素上限 |
| PAR-004 | 独立 `document-parser-service`，来源白名单；Compose 只读根/cap drop/PID/CPU/内存/tmpfs | Parser 启动与 readiness、SSRF 测试、Compose config          |
| PAR-005 | Parser/OCR Port、`OcrTarget[]`、Zod、protocol/revision 双重校验                        | Controller + HTTP Adapter Schema/版本测试                   |
| PAR-006 | `document-parser-core` 九类真实 Parser Registry                                        | TXT/CSV/HTML/Markdown/PNG/PDF/DOCX/XLSX/PPTX 合成 Golden    |
| PAR-007 | PDF 页级覆盖率、Office 归档图片候选、`selectOcrTargets`；HTML/Markdown 禁止外部抓取    | 数字 PDF、图片/Office Target、原生优先合并测试              |
| PAR-008 | Target 级 OCR result、bbox/confidence/version、低置信 Issue                            | 编排测试和 HTTP OCR 越权 Target 测试                        |
| PAR-009 | `ParsedBlockCandidate -> DocumentBlockDraft`，M03 停在 CHUNK WAITING                   | 类型边界、Repository 事务                                   |
| PAR-010 | ordinal + version/content hash 稳定 ID，独立 originalText                              | 稳定 ID/原文测试                                            |
| PAR-011 | table rows/header/merged、sheet/slide/page/bbox、图片资产路径                          | DOCX/XLSX/PPTX/PDF Golden                                   |
| PAR-012 | derived 版本化 Key、SHA metadata、HEAD 复用                                            | MinIO Adapter + 编排测试                                    |
| PAR-013 | Abort/Deadline/输入响应上限/有限重试、三类故障、lease fencing                          | 429、协议错误、SSRF、对象错误与 PG lease SQL                |
| PAR-014 | 真实合成格式 Fixture + Jest Snapshot + Office 安全样本                                 | `document-parsers.spec.ts` 12 项、5 个 Snapshot             |
| PAR-015 | 管理 API、任务解析面板、Profile/版本/耗时/失败原因                                     | OpenAPI、Vue 测试、管理员授权测试                           |

## 2. 本轮新增交付

- 独立 NestJS `document-parser-service`，`/v1/parse`、`/v1/health/live`、`/v1/health/ready`、`/v1/metrics`。
- `ParserRegistry` 注册 PDF、DOCX、XLSX、PPTX、IMAGE、HTML、MARKDOWN、TEXT、CSV；未注册或重复注册属于开发缺陷。
- OOXML 安全读取：lazy entry、Zip Slip、重复条目、加密、条目数、单项/累计物化大小、单项/累计解压比、核心部件真伪、宏、ActiveX、嵌入对象、外链。
- DOCX 标题/段落/列表/表格/合并/媒体；XLSX Sheet/公式原文与缓存值/合并/图片 anchor/远端稀疏单元格门禁；PPTX slideNo/文本框/表格/图片 bbox；PDF 页文本/链接/矢量表格/按需 OCR。
- 自有有界图片头解析器支持 PNG/JPEG/GIF/TIFF/BMP/WebP；移除存在无限循环 DoS 公告的通用图片探测依赖。
- OCR v2 目标契约，覆盖 PAGE、REGION、EMBEDDED_IMAGE、WHOLE_IMAGE；HTTP/Fixture/Docling Adapter 均按能力显式处理。
- 旧外置病毒库的 TypeScript Adapter、TCP 配置、Compose Service/Volume 和镜像变量已删除。替换为纯 Node 流式规则，Profile 明示 `NO_SIGNATURE_DATABASE`。
- 内外网默认 Parser 都走项目 Node Parser HTTP 契约；PaddleOCR、LLM、Embedding、Reranker、Milvus 仍由环境 Profile 注入。

## 3. 已执行证据

本轮开发过程中已经执行并通过：

```text
TypeScript strict typecheck: passed
Node Parser Golden/security: 21 passed, 5 parser snapshots passed
Backend unit/contract: 148 passed, 19 snapshots passed
Frontend: 7 passed
PostgreSQL/Redis M01～M04 integration（不含已停止的 MinIO/Milvus health suite）: 11 passed
ESLint + dependency boundaries: passed（227 modules / 488 dependencies）
Migration/OpenAPI/三组 Compose config: passed
五个后端应用 + Vue production build: passed
document-parser-service real process + 合成 PDF HTTP 解析: passed
/v1/parse: revision=1.0.0, protocolVersion=2, text block=1, OCR targets=0
production dependency audit: critical/high/moderate = 0
offline dependency audit: passed（可选 Docling 镜像 digest 仍为 release warning）
```

完整 `pnpm check` 已通过。基础设施健康套件本轮明确未计入通过项：本机仅 PostgreSQL 和两类 Redis 正在运行，MinIO/Milvus 处于停止状态；考虑 C 盘已满，本轮没有擅自启动或拉取这些容器。代码进入内网前仍需按第 5 节补真实基础设施和 Provider 证据。

Parser 专用指标：

- `rag_m03_parser_runs_total{format,result}`；
- `rag_m03_parser_duration_seconds{format,result}`；
- 标签不包含文件名、URL、userId、documentId 或 jobId。

## 4. 安全边界说明

- 原始对象只在 quarantine；只有结构安全结论 CLEAN 才写 derived。
- 内置 Scanner 必须完整消费流，重新计算大小/SHA，规则跨 chunk 匹配；异常、超限或取消不会伪装 CLEAN。
- 内置规则只识别 EICAR、PE/ELF/Mach-O/Shebang 和大小上限，没有病毒特征库；未知恶意代码检出能力不能与企业反病毒产品等价。
- Office 活动内容、路径穿越、重名混淆、加密、压缩炸弹、累计物化内存、外链和嵌入对象由 Node Parser 检查；嵌入二进制永不执行。
- 图片头读取只进入六种白名单处理器；未知 ICNS/JXL/HEIF 等格式在循环前即被拒绝。
- Parser URL 使用 hostname 精确白名单、禁止重定向/URL 凭据，并同时检查 Content-Length 与实际流大小。
- production 禁止 Fixture 和 Docling 直连 Parser；标准 HTTP 响应缺字段、协议或 revision 不一致都会 fail closed。
- 只有 OCR/MERGED Block 写 `ocrEngine/ocrRevision`；同一文档的可靠原生 Block 不会被错误标成 OCR。

## 5. 仍需真实内网补跑的证据

这些项目依赖用户尚未提供的内网 Endpoint/凭据或部署容量，当前不能伪造：

- PaddleOCR 对 PAGE/EMBEDDED_IMAGE/WHOLE_IMAGE 的真实请求/响应映射、中文置信度和 bbox；
- 企业脱敏复杂 PDF/DOCX/XLSX/PPTX 模板差异，尤其 PDF 是否要求字形级 bbox；
- MinIO 预签名 URL 在 Parser 容器中的 DNS、白名单和过期行为；
- 中型规模并发、2 GiB 上传与 256 MiB Parser 默认上限的产品策略；
- Parser CPU/内存限制、kill 恢复和 8 小时 soak；
- 企业批准的 SCA/SBOM 与可选反恶意软件服务。

当前 PDF Block bbox 明确为 `APPROXIMATE_LINE_ORDER`。若验收要求字形级高亮，应新增高精度 PDF Adapter、升级 Parser revision 并重建内容，不能直接勾选该质量项。
