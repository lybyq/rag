# 文件解析与OCR 文件安全、Node Parser 与 OCR：实施证据

> 更新日期：2026-09-06。本文严格区分“仓库可自动证明的实现”与“必须进入真实内网才能补跑的 Provider/容量证据”。

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
| PAR-009 | `ParsedBlockCandidate -> DocumentBlockDraft`，文件解析与OCR 停在 CHUNK WAITING         | 类型边界、Repository 事务                                   |
| PAR-010 | ordinal + version/content hash 稳定 ID，独立 originalText                              | 稳定 ID/原文测试                                            |
| PAR-011 | table rows/header/merged、sheet/slide/page/bbox、图片资产路径                          | DOCX/XLSX/PPTX/PDF Golden                                   |
| PAR-012 | derived 版本化 Key、SHA metadata、HEAD 复用                                            | MinIO Adapter + 编排测试                                    |
| PAR-013 | Abort/Deadline/输入响应上限/有限重试、三类故障、lease fencing                          | 429、协议错误、SSRF、对象错误与 PG lease SQL                |
| PAR-014 | 真实合成格式 Fixture + Jest Snapshot + Office 安全样本                                 | `document-parsers.spec.ts` 12 项、5 个 Snapshot             |
| PAR-015 | 管理 API、任务解析面板、Profile/版本/耗时/失败原因                                     | OpenAPI、Vue 测试、管理员授权测试                           |
| PAR-016 | OCR 逐目标完整性/定位/质量判定、原生内容保留和人工审核事务                             | 纯函数、HTTP Adapter、应用编排及 PostgreSQL 集成测试        |
| PAR-017 | 九格式统一资源预算、可终止 Worker、并发背压和容量指标                                  | 小预算、稀疏表、硬取消、Worker bundle smoke                 |
| PAR-018 | DOM 阅读顺序、文本归属、列表/引用/代码语义及有界表格矩阵                               | HTML/Markdown 6 项回归 + Parser/Chunking 快照               |
| PAR-019 | XLSX 媒体 relationship、出现位置、多区域、公式/格式与源坐标事实                        | XLSX 5 项合成 OOXML 回归 + Golden                           |
| PAR-020 | PPTX 真实页序、Run/表格、模板继承、组合坐标与未支持能力告警                            | PPTX 5 项合成 OOXML 回归 + Golden                           |
| PAR-021 | DOCX drawing relationship、图片 occurrence、OCR 正文锚点与版面边界                     | DOCX 6 项合成 OOXML 回归 + Parser Core                      |
| PAR-022 | PDF TextItem 坐标、阅读顺序、标题依据、装饰元素、页面分类及对象安全检查                | PDF 8 项合成文档回归 + Parser/Chunking                      |
| PAR-023 | TXT 严格解码/原始换行、CSV 方言/表头/矩形、图片完整页帧与方向边界                      | 边界专项 13 项 + 九格式回归                                 |
| PAR-024 | Parser 1.1.0、快照跨 revision 隔离、新 content revision、质量门禁与原子索引发布        | 路径单测 + PostgreSQL 三组 10 项集成测试 + 全量门禁         |

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
PostgreSQL/Redis 身份权限与知识空间～知识加工与质量 integration（不含已停止的 MinIO/Milvus health suite）: 11 passed
ESLint + dependency boundaries: passed（227 modules / 488 dependencies）
Migration/OpenAPI/三组 Compose config: passed
五个后端应用 + Vue production build: passed
document-parser-service real process + 合成 PDF HTTP 解析: passed
/v1/parse 基线当时为 revision=1.0.0, protocolVersion=2, text block=1, OCR targets=0；阶段 9 完成后代码与部署模板已统一升级到 revision=1.1.0
production dependency audit: critical/high/moderate = 0
offline dependency audit: passed（可选 Docling 镜像 digest 仍为 release warning）
```

完整 `pnpm check` 已通过。基础设施健康套件本轮明确未计入通过项：本机仅 PostgreSQL 和两类 Redis 正在运行，MinIO/Milvus 处于停止状态；考虑 C 盘已满，本轮没有擅自启动或拉取这些容器。代码进入内网前仍需按第 5 节补真实基础设施和 Provider 证据。

Parser 专用指标：

- `rag_document_parser_runs_total{format,result}`；
- `rag_document_parser_duration_seconds{format,result}`；
- `rag_document_parser_output_characters{format}`；
- `rag_document_parser_table_cells{format}`；
- `rag_document_parser_expanded_table_cells{format}`；
- `rag_document_parser_pixels{format}`；
- 标签不包含文件名、URL、userId、documentId 或 jobId。

2026-09-06 的 Parser 资源预算补充证据：

- `ParseResourceBudget` 在数组补齐、跨度展开、像素与大字符串创建前累计，真实和展开单元格分开记录。
- 同步 CPU 阶段运行在单任务 Worker Thread；父线程可硬终止，最大并发默认 2，满载返回可重试 503。
- 新增五类 `FILE_MAX_*` 预算配置，全部进入内外网/离线模板；协议版本仍为 v2。
- 预算/配置/Worker/Controller 31 项测试通过；九格式 Golden/security 21 项、5 快照通过；生产 bundle 与真实 Worker smoke 通过。

2026-09-06 的 HTML/Markdown 结构恢复补充证据：

- 共用抽取器不再使用全局固定标签选择器读取整棵子树文本，而是按同级 DOM 顺序分配 own text。
- `br`、`pre`、引用、列表层级与编号均有显式语义；父列表项不再重复包含子项。
- 表格使用直接行策略隔离嵌套表，尾部 rowspan/colspan 补齐后逐项验证合并坐标。
- 专项 6 项测试、Parser/Chunking 联动 52 项与 10 快照通过。

2026-09-06 的 XLSX 图片与表格事实补充证据：

- 图片由 ExcelJS 已解析的 media index/name 精确关联归档条目，第一张 ID=0、image10、重复引用和非连续 picture42 均通过。
- Sheet 按空白行列切分连续区域，TABLE 元数据保留源范围、源行列、表头推断和局部合并坐标。
- 公式缓存缺失不会把表达式写成结果；百分比、货币、日期、前导零和原 numFmt 可审计。
- XLSX 专项 5 项、Parser 相关 30 项与 5 快照通过。

2026-09-06 的 PPTX 页序与结构事实补充证据：

- `slideNo` 来自 presentation 的 sldId 顺序与 relationship，覆盖 slide10 排在 slide2 前的删除/重排场景；损坏关系 fail closed。
- 同段 Run 直接连接，显式换行与段落边界才换行；标题占位符可从 layout/master 继承并记录来源。
- 组合图形的内外坐标系递归换算；表格从 `a:tc` 读取二维合并与 continuation，表格文字计入页统计。
- 隐藏页、备注、图表、SmartArt 和复杂旋转均有可观察告警；PPTX 专项 5 项、相关 Golden 26 项与 5 快照通过。

2026-09-06 的 DOCX 图片与结构事实补充证据：

- 正文 `r:embed/r:id` 经 document relationships 精确关联 `word/media`；重复资产生成独立 occurrence/targetId，缺失关系拒绝而非猜测。
- IMAGE Block 保留段落、段内 drawing、锚定类型与归档路径；成功 OCR 由 Parser Core 紧跟 `ocrTargetId` 锚点插入。
- DOCX 全部 pageNo/bbox 保持 null；企业自定义 outline 标题、嵌套编号列表和合并表格有合成回归。
- 页眉页脚、脚注尾注、文本框、修订及未知图片能力返回稳定告警；专项 6 项，DOCX/Parser/OCR 相关 35 项与 5 快照通过。

2026-09-06 的 PDF 结构恢复与 OCR 决策补充证据：

- 复用锁定的 `pdf-parse 2.4.5 / PDF.js 5.4.296` 已加载文档读取 TextItem；真实 transform/viewport 生成 bbox，并保留字体、字号和旋转事实。
- 先按视觉基线和水平间隙恢复行段，再以足够证据识别双栏；标题推断记录 `pdf-heading-v1`、置信度和逐项依据，元数据 Title 不冒充正文标题。
- 重复页眉页脚成为 HEADER/FOOTER 并由 Chunking 排除；跨页正文只记录连续关系，不合并跨页引用。
- 图片 operator、原生文字质量和页级状态共同区分扫描、混合、空白与正常短文字页；只有需要的页进入 OCR。
- 矢量表格与命中文字去重；附件、JavaScript 和 OpenAction 使用对象模型检查，能力失败才使用显式不完整的下限扫描。
- PDF 专项 8 项、相关 Parser/Chunking 54 项与 10 快照通过；TypeScript strict、定向 ESLint/Prettier 通过。

2026-09-06 的 TXT、CSV 与图片能力边界补充证据：

- TXT 严格接受 UTF-8/UTF-8 BOM/带 BOM UTF-16LE/BE，拒绝非法编码、奇数字节 UTF-16 和 NUL 二进制；CRLF/LF/CR 原样审计、统一 LF 检索。
- TXT 使用 `BLANK_LINE_V1` 空白行分段并保存源行号，不推断标题。
- CSV `csv-delimiter-v1` 在引号外识别四种分隔符，标准状态机保留转义与跨行字段；`csv-header-v1` 证据不足时保留首行而不是假定表头。
- CSV 空记录和源列宽可追溯，不规则行补齐为矩形，真实 7/展开 12 等预算事实有永久回归。
- 图片检查遍历 TIFF IFD、GIF、APNG 和 WebP 页帧结构，方向事实可见；像素按全部内容单元累计后，多页/动画以稳定错误明确拒绝。
- 边界专项 13 项、document-parser-core/Parser Core 77 项与 5 快照通过；TypeScript strict、定向 ESLint/Prettier 通过。

2026-09-06 的 Parser revision 与原子发布补充证据：

- Parser 默认 revision 及内网、外网、airgap、发布包环境模板从 `1.0.0` 统一升级到 `1.1.0`，HTTP protocol 仍为 v2，Provider 地址、认证方式和服务名均未改变。
- derived Key 变为 `derived/{documentVersionId}/content-r{N}/parser-{profile}/revision-{revision}/blocks.json`；Profile/revision 路径段经过校验，两个 Parser revision 不会命中同一对象。
- HTTP 公共错误体只读取有界字节并保留稳定 code/retryable，不透传远端 message；Parser 的格式能力错误不会被退化为普通 HTTP 状态码。
- PostgreSQL 文档接入、知识加工、索引发布三组集成测试共 10 项通过，覆盖新 content revision 保留旧事实、并发质量审核、索引构建失败不切 Head、原子发布和历史版本回滚。
- 全量结果：后端 74 个 Suite/373 项、前端 6 个 Suite/10 项和 19 个 Snapshot 通过；TypeScript strict、ESLint、378 模块/898 依赖边界、16 个迁移、OpenAPI、六应用构建和四组 Compose config 通过。
- 离线依赖审计通过；可选 Docling 镜像尚未锁 digest，只形成 warning，不影响当前内网 HTTP PaddleOCR 路线。
- 已生成 `0.1.2-intranet-d00a0fd5-dirty` 的 linux/amd64 六镜像离线包；`rag-apps.tar` 为 979,466,752 字节，SHA256 为 `aeeb3bc9fbbffcda8153706dd2909b261e20e3ddb2bc9629d817440b28328d45`，发布目录 `verify.ps1` 全文件校验通过。`dirty` 是清单中显式记录的事实，表示本轮尚未提交的 Parser 改动已进入镜像，不冒充可由 Git commit 单独重现的正式签名构建。

2026-09-05 的 OCR 正确性补充证据：

- `HttpOcrAdapter` 拒绝重复请求、重复/额外响应和冲突定位；缺失结果显式写入兼容 warning。
- Parse Run 的 `metrics.ocrOutcomeCounts` 只记录 SUCCESS/MISSING/EMPTY/LOW_CONFIDENCE/INVALID_LOCATION/DUPLICATE_RESULT/UNSUPPORTED 计数，不含 targetId。
- 关键 PAGE/WHOLE_IMAGE 不可用时，PostgreSQL 同一事务保存 Block、Issue、Snapshot 定位并转 `WAITING`，不会插入 `ingestion.knowledge_processing.requested` Outbox。
- 定向单元/契约测试 22 项通过；Parser/OCR/Chunking 回归 69 项、19 快照通过；PostgreSQL 文件解析事务 2 项通过。

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
