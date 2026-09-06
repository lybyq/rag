# 03｜代码走读：按真实执行顺序理解 Node Parser 全链路

这份 Walkthrough 承担“逐句学习”的职责。源码中的 JSDoc 说明长期职责，这里按一次请求真正发生的顺序解释关键变量、分支和保护代码。

## 1. Worker 为什么先扫描，再识别，再签 URL

入口在 `libs/application/src/document-processing.service.ts` 的 `process()`：

1. `loadInput(jobId, workerId)` 只读取当前 lease 持有者能处理的事实；拿不到输入直接结束，旧 Worker 不得继续。
2. `beginRun()` 把部署 `providerProfile`、Parser/OCR profileId 和 revision 固定到 Run。进程之后切 Profile 也不能改变历史任务含义。
3. `storage.readObject()` 返回 `AsyncIterable<Uint8Array>`。`observeContent()` 包装这个流；每个 chunk 同时更新 SHA-256、总字节数和前 8 KiB header，然后原样 yield 给 Scanner。
4. `BuiltinContentSafetyScannerAdapter.scan()` 必须完整消费这个流。只有消费完毕，`observation.result()` 才允许返回；若 Adapter 偷懒提前结束，会抛出“Scanner 未完整消费输入流”。
5. 扫描字节数、MinIO 对象大小、上传完成大小和可选上传 SHA 任一不一致，按 `DOCUMENT_PROBLEM` 拒绝。这堵住了上传完成后对象被替换的窗口。
6. `detectFileFormat()` 以魔数为主，扩展名和 MIME 为交叉约束。ZIP 这里只能初判为 OOXML 候选；DOCX/XLSX/PPTX 的内部事实由 Parser 再检查。
7. 只有预检成功才签发短时 GET URL。URL 只存在内存，不进入 Run、日志或快照。

如果删除“完整消费 + 大小/SHA 比较”，一个只读首块就返回 CLEAN 的 Scanner 会让后半文件完全绕过安全门禁。

## 2. 内置 Scanner 怎样跨 chunk 检测

文件是 `libs/file-processing-providers/src/builtin-content-safety-scanner.adapter.ts`：

1. `signatures` 把规则声明成 `name + bytes + onlyAtStart`。EICAR 可在任意位置，可执行魔数只能在偏移 0 命中。
2. EICAR 字符串在源码中分段组合，避免宿主机安全产品把仓库源码误隔离；测试也用相同公开标准样本验证。
3. `maximumSignatureLength` 决定尾部窗口大小。每轮只保留“最长签名长度 - 1”字节，既能匹配上一 chunk 尾部与下一 chunk 头部，又不会随 2 GiB 文件增长内存。
4. `absoluteWindowOffset` 把窗口内索引还原成文件绝对偏移，保证普通正文中偶然出现 `MZ` 不会被当成 PE 文件头。
5. `scannedBytes > maxBytes`、Abort 或迭代异常全部抛错，不返回 CLEAN。
6. 返回 Profile 包含 `NO_SIGNATURE_DATABASE`，提醒运维和面试官：这里是内容安全预检，不是完整反病毒引擎。

## 3. Parser Service 如何挡 SSRF 和大响应

HTTP 入口是 `apps/document-parser-service/src/parser.controller.ts`：

1. `ParserHttpRequestSchema.strict()` 拒绝未知字段，防止调用方和服务端悄悄产生两套协议。
2. 共享密钥为空时依赖隔离网络；配置后只接受 Bearer，并使用 `timingSafeEqual` 比较。
3. 请求的 `protocolVersion` 必须等于进程配置。版本不同返回 409，不能猜测兼容。
4. `AbortSignal.any([clientAbort, timeout])` 把客户端断开和绝对 Deadline 合并，下载和每个 Parser 长循环都收到同一取消信号。
5. `ParserSourceLoader.validateUrl()` 只允许 http/https、精确 hostname 白名单、无 URL 用户信息；fetch 使用 `redirect: error`，防止白名单 URL 302 到公网或云元数据地址。
6. `Content-Length` 先挡明显超限，`readResponseWithLimit()` 再对 chunk 实际总量兜底；超限立即 cancel reader。
7. 指标标签只用固定格式和结果，不记录文件名、URL、用户或文档 ID。

## 4. Registry 为什么还要再过一次 Zod

`libs/document-parser-core/src/parser-registry.ts`：

1. 构造时把 `format -> parser` 放入 Map；Map 大小和数组长度不同表示重复注册，属于开发缺陷。
2. 输入大于 `maxInputBytes` 在进入第三方库前拒绝。
3. `parsers.get(input.format)` 只信上游已经交叉校验的枚举，不再次按文件名猜测。
4. 格式 Parser 返回 `FormatParseOutput` 后，Registry 补 `parserName/revision/protocol/durationMs`。
5. 最后 `ParserResultSchema.safeParse()` 是内部实现的最后一道防线。某个 Parser 漏字段或产生非法 bbox 会转成 `PARSER_OUTPUT_SCHEMA_MISMATCH`，不会污染 知识加工与质量。

## 5. OOXML 安全读取为什么必须先于 Mammoth/ExcelJS

`libs/document-parser-core/src/safe-ooxml.ts` 是 DOCX/XLSX/PPTX 的共同前置：

1. yauzl 使用 `lazyEntries` 串行打开条目，避免多个解压流共同放大内存。
2. `normalizeEntryName()` 拒绝 NUL、反斜线、绝对路径、盘符和 `..`，所以即使未来改成落盘也不会产生 Zip Slip。
3. 每个 entry 在解压前用 central directory 的 compressed/uncompressed size 计算单项和累计压缩比；超过阈值不打开炸弹流。
4. `maxArchiveEntries` 防止几十万小条目耗尽事件循环和对象内存。
5. XML/关系/媒体才有限保存在内存；嵌入 OLE/ActiveX 二进制只计数、完整消费校验，但永不加载或执行。
6. 最后必须且只能命中 `word/document.xml`、`xl/workbook.xml`、`ppt/presentation.xml` 之一。扩展名为 docx、内部却是 xlsx 会失败。
7. `.rels` 中 `TargetMode=External` 计数；`vbaProject.bin/macrosheets/activeX` 标记宏；`embeddings/activeX` 标记嵌入对象。

如果把 Mammoth/ExcelJS 放在安全检查前，压缩炸弹可能在我们看到 inspection 之前已经耗尽内存。

## 6. 九种格式各自恢复什么

- PDF：`pdf-parse`/pdfjs-dist 提取逐页文本、链接和矢量表格；Parser 报告无文字页，应用层再按配置阈值补充低覆盖 PAGE Target。当前 bbox 是明确标注的页内行序近似，不是假装字形坐标。
- DOCX：Mammoth 转结构 HTML，公共 HTML 映射恢复标题、段落、列表、表格与合并；`word/media` 形成 EMBEDDED_IMAGE Target。
- XLSX：ExcelJS 保留 Sheet、公式缓存值、合并范围和图片 anchor；稀疏 Sheet 只物化实际行，防止一个远端坐标制造百万空行。
- PPTX：直接读 slide XML 和 rels，恢复 slideNo、文本框、标题、表格、图片 bbox 与媒体路径。
- IMAGE：自有有界头解析器只支持平台白名单内的 PNG/JPEG/GIF/TIFF/BMP/WebP；整图形成 WHOLE_IMAGE Target，不在 Parser 内 OCR，也不加载通用库里无关的高风险格式处理器。
- HTML：Cheerio 删除 script/style/object/embed/iframe，不发起资源请求；恢复标题、列表、代码、表格和图片 Block，但外部图片默认不生成 OCR Target。
- Markdown：markdown-it 禁止原始 HTML，再复用 HTML 结构映射。
- TXT：显式处理 UTF-8/UTF-16 BOM，以空行分段并保留 originalText。
- CSV：csv-parse 处理引号、嵌套换行和不齐列，整表输出统一 TABLE 并执行单元格上限。

### 6.1 图片头为什么自己实现

`image-dimensions.ts` 不解码像素，只读取六种已通过上传魔数门禁的宽高字段：PNG/GIF/BMP 是固定偏移；WebP 按 VP8X、VP8、VP8L 三种 Chunk 分支；JPEG 逐 Segment 前进且每次使用 Segment 长度；TIFF 只遍历首个 IFD。所有读取先过 `assertRange()`，JPEG/TIFF 的循环上限由实际字节数决定，所以损坏输入不能形成无限循环。

这样做不是“所有依赖都自己造”。触发点是生产依赖审计发现原通用库在项目根本不需要的 ICNS/JXL/HEIF 处理器里存在无限循环，而其修复版尚不可安装。仅在调用前判断扩展名不够，因为通用库仍会按内容自动识别；真正缩小攻击面的做法是删除依赖，让未知格式根本没有可达处理器。若未来要增加 AVIF/HEIF，必须新增显式格式需求、资源上限、恶意头测试和 Parser revision。

## 7. OCR 为什么不能“请求成功就替换原文”

阶段 1 修复后的真实顺序是：

1. `selectOcrTargets()` 先合并 Parser 给出的图片候选和自动 PAGE 候选。自动 PAGE 只对 PDF 生效；PPTX 的 `pages` 实际代表 Slide，不能因为一页字符少就把它发送成通用 PAGE OCR。
2. `selectOcrPages()` 只自动选择明确 `imageOnly` 或字符数确实为零的页。字符覆盖率只是代理值，十二个字的章节标题不是扫描失败，不能因为“字少”删除标题。
3. `selectSupportedOcrTargets()` 读取 OCR Profile 的能力清单。Provider 一旦声明了目标能力，未声明支持的 PAGE、REGION、EMBEDDED_IMAGE 或 WHOLE_IMAGE 就不会被发送。旧 Provider 的空能力数组仍按兼容模式处理。
4. `HttpOcrAdapter` 在发请求前拒绝重复 targetId；响应回来后拒绝重复结果、额外结果和页/Slide/Sheet 冲突。Provider 省略但可从请求目标确定的位置由 Adapter 补齐，供应商私有字段不会进入应用层。
5. `assessOcrTargetResults()` 逐目标给出 `SUCCESS/MISSING/EMPTY/LOW_CONFIDENCE/INVALID_LOCATION/DUPLICATE_RESULT`。只有 `SUCCESS` 的 Block 才进入合并函数。
6. `mergeOcrBlocks()` 只在 PAGE 状态为 SUCCESS 时替换同页原生 Block。REGION、EMBEDDED_IMAGE、WHOLE_IMAGE 即使成功也只补充，避免一张截图 OCR 删除整个 PPT 页的可靠文本框。
7. PAGE 或 WHOLE_IMAGE 失败代表主要正文仍不可靠。应用层保存原生 Block、结构化 Issue 和 derived Snapshot，但把任务停在 `WAITING`，不创建 Chunk Outbox。局部图片失败只记 WARNING，不阻断已有可靠正文。

这套设计解决的是“部分成功伪装成完整成功”：HTTP 200 只说明 OCR 服务响应了，不说明请求的每一页都有可靠文字。

`buildDocumentBlocks()` 仍只在候选 metadata 的 `extractionSource` 为 OCR/MERGED 时写 `ocrEngine/ocrRevision`。同一文档调用过 OCR，不代表所有原生 Block 都来自 OCR。

## 8. 最终事务和故障传播

安全结论为 REJECTED 或 MANUAL_REVIEW 时不会进入 知识加工与质量。正常路径写版本化 `blocks.json`，SHA 相同可复用；PG `complete()` 在一个事务内写 Block、Issue、Run 和任务步骤。每次提交前再次检查 lease，旧 Worker 即使晚到也不能覆盖新 Worker。

OCR 质量审核路径也使用同一个 `complete()` 事务，但 `requiresManualReview=true`：Run、Job、DocumentVersion 和当前 NORMALIZE 步骤一起变成 `WAITING`，保存 `ocrOutcomeCounts`，并且提前提交事务，不执行后面的 CHUNK 排队和 Outbox 插入。这样审核页面能看到原文、Issue 和快照，错误内容又不会进入索引。

错误分类：确定性坏文档不重试；网络/429/5xx/Deadline 有限重试；Schema/revision/内部不变量错误进入开发缺陷。日志只记录稳定 code 和 Trace，不记录正文、预签名 URL 或密钥。

排查时先看 Parse Run 的 `metrics.ocrOutcomeCounts`：`MISSING/EMPTY/LOW_CONFIDENCE/UNSUPPORTED` 都是低基数计数。再到 Issue 查看单个 targetId、类型、页码和阈值；不要把 targetId 放进 Prometheus 标签，否则每个图片都会制造一条新时间序列。

## 9. 统一资源预算为什么还需要 Worker

`ParserRegistry.parse()` 为一次文档创建一个 `ParseResourceBudget`，并把同一个对象传给具体格式 Parser：

1. `assertTableShape()` 在创建稀疏列、补齐行或扩大矩阵前检查单表最大行列。
2. `consumeTableCells(actual, expanded)` 分开记录源文档真实单元格与 rowspan/colspan/矩形补齐后的占位数。两者混为一个数字，会让“普通大表”和“很小但跨度恶意的表”无法区分。
3. `assertTableSpan()`、`tableArea()` 在乘法前先比较 `Number.MAX_SAFE_INTEGER / 另一因子`，避免数值溢出变成一个较小数字后绕过上限。
4. `consumeOutputCharacters()` 在 join 大字符串前累计；超过上限抛 `PARSER_OUTPUT_LIMIT_EXCEEDED`，不会截掉后半正文然后标记成功。
5. `consumePixels()` 同样先验证宽高和安全乘法；图片尺寸未知保持 null，不把“没检查出来”冒充“0 像素已通过”。
6. Registry 最后按真实 `Block.originalText` 再核对一次。这是防止某个格式实现漏记的兜底，不代替循环前检查。

预算检查仍有一个物理限制：Cheerio、Mammoth、ExcelJS 等第三方同步代码执行时，JavaScript 主线程没有机会运行 Deadline 定时器。只传 `AbortSignal` 看起来支持取消，实际上可能要等第三方函数返回才生效。

因此 HTTP 主线程不直接调用 Registry，而由 `WorkerDocumentParserExecutor` 把文件字节、限制和 revision 发送给单任务 Worker：正常完成后回收 Worker；Deadline 或客户端断开时 `terminate()` 只杀当前线程。并发数默认 2，超过后立即返回可重试 503，不把几十份 256 MiB 文件留在内存排队。最后还有 Parser 容器的 CPU/内存/tmpfs 限制，形成“算法预算—线程终止—容器配额”三层边界。

面试追问“为什么不用一个常驻 Worker 池”时，可以回答：当前 Parser 处理的是不可信且格式多样的文件，短生命周期 Worker 能彻底清掉第三方库残留状态，隔离更强；代价是每次约有线程启动成本。中型规模先用并发 2 和 BullMQ 吸收峰值，真实压测证明启动成本成为瓶颈后，再实现有最大任务数/RSS 回收阈值的受控池，而不是无限复用线程。

## 10. HTML/Markdown 为什么不能用一个大选择器抓完

旧实现相当于“找到所有 h1、p、li、table，再对每个节点调用 text()”。它简单，但 DOM 的 text() 会递归包含全部子孙，于是出现四类典型错误：`div` 里的裸文本没有命中任何选择器而丢失；`li` 把子列表文本一起吸收后子项又输出一次；`br` 没有文字所以前后粘连；外表查找全部 `tr` 时把内表行也塞进外表。

新实现按真实 DOM 子节点顺序工作：

1. `visitNodes()` 只把相邻文本节点和行内标签放进 pending；遇到块元素先 flush 父容器自己的段落，再让子块处理自己的内容。
2. 普通源码里的缩进换行只是 HTML 排版空白，会折叠成空格；只有 `br` 写入私有硬换行哨兵，最终还原成 `\n`。`pre` 走独立递归，完全不做空白折叠。
3. 列表项使用 own-text 收集器，遇到内层 ul/ol 立即停止；然后再递归内层列表。`listDepth/listKind/itemNumber/listMarker` 让 Chunk/UI 能恢复层级和编号。
4. 表格只读取 table 直系 tr，或直系 thead/tbody/tfoot 下的 tr。单元格文本遇到内层 table 停止，内表随后作为独立 TABLE Block 输出并带告警。
5. rowspan/colspan 先占位，再根据跨度终点扩展行数与列数，最后补成矩形；所以“最后一个单元格跨到并不存在的下一行”也不会产生越界 merged cell。

这里的 `originalText` 不是 HTML 源码，而是“HTML 实体解码后，按浏览器文本空白规则恢复的结构原文”。后续标准化只处理 `text`，`originalText` 继续用于审计与稳定 Hash。若业务要保留标签级原始字节，应另存 source artifact，不能把两种语义塞进同一个字段。

## 11. XLSX 为什么不能按 image1、image2 排序

ExcelJS 的 `workbook.addImage()` 第一张图片 ID 是 0，而旧代码按一基数组取 `media[imageId - 1]`，第一张必然找不到。更隐蔽的是字符串排序中 `image10.png` 排在 `image2.png` 前面，图片达到十张后 OCR 会读错字节；同一图片重复出现时，drawing 次数也不等于媒体资产数。

新链路把“资产”和“出现位置”分开：

1. ExcelJS 加载 OOXML 时已经根据 drawing relationship 建立 `imageId -> workbook.model.media[index]`；Parser 使用媒体自己的 `name + extension` 精确匹配 `xl/media`。
2. 每个 worksheet drawing 仍单独生成 targetId 和 IMAGE Block，保存 Sheet、drawingIndex、源 anchor、bbox 与 `ocrTargetId`。同一 media index 可被多个位置引用。
3. OCR 读取的是 assetRef 指向的归档字节，结果根据 targetId 回到具体出现位置。资产可去重，出现位置不能去重。

工作表表格也不能简单做成“从 A1 到最远单元格的一张大表”：两个并排表会被空白列粘成一张，远端稀疏坐标还会制造巨大矩阵。实现先扫描非空/合并坐标，通过空白行分带、空白列分区；每个区域在创建二维数组前计算面积预算，并保存源行列映射。

公式是另一个常见面试坑。XLSX 文件通常只保存公式表达式和“上次由 Excel 计算的缓存结果”，Node Parser 不应实现一套不完整公式引擎。缓存存在时正文用缓存结果；缓存缺失时正文留空、metadata 保存表达式并标记 MISSING，同时给出可见 warning。这样 `=SUM(A1:A10)` 不会被大模型误当作财务结果。

数字显示同样承载业务语义：0.125 可能表示 12.5%，1234.5 可能是 `$1,234.50`，字符串 `0012` 的前导零可能是员工编号。Parser 对确定性强的格式生成 displayText，同时保存 rawValue 和 numFmt；遇到复杂企业自定义格式时保留事实并扩展测试，而不是只存 JavaScript `String(value)`。

## 12. PPTX 为什么 slide10 不一定是第十页

PowerPoint 的真正页序不在文件名。用户删除、复制或重排幻灯片后，ZIP 中可能同时出现 `slide2.xml`、`slide10.xml`，而 `slide10` 完全可能排在第一页。真实顺序在 `presentation.xml` 的 `p:sldIdLst`，每个 `r:id` 再通过 `ppt/_rels/presentation.xml.rels` 指向 Slide Part。

新解析顺序如下：

1. `readPresentationSlides()` 先按 `sldIdLst` 顺序取关系 ID，再解析到归一化归档路径；关系缺失、重复或目标不存在都按损坏文档拒绝，不能换成文件名排序后假装成功。
2. 只有旧合成文档完全没有 `sldIdLst` 时才按数字文件名回退，同时返回 `PPTX_PRESENTATION_ORDER_FALLBACK`。这保留了兼容性，也让管理员知道页序可信度下降。
3. `slideNo` 是真实顺序的一基位置，不是文件名数字；Block 另存 `archiveEntryPath`，所以“用户看到的第几页”和“归档中哪份 XML”都能追溯。

文本不能把每个 `a:t` 都用换行连接。PowerPoint 会因为字体、颜色或粗体把一句话拆成多个 Run；Run 是样式边界，不是语义换行。`readTextBody()` 只在 `a:p` 段落边界和 `a:br` 显式换行处插入 `\n`，同一段的 Run 直接连接。否则向量化会把一句话拆碎，关键词检索也会混入无意义换行。

标题有三层继承：Slide 的 `p:ph` 可能只有 `idx`，真正的 `type=title` 在 Slide Layout，甚至继续继承自 Slide Master。Parser 沿 slide relationship -> layout relationship -> master 查询，并把 `placeholderTypeSource` 写入 metadata。这样标题 Chunk 路径既能恢复，又能解释“为什么它被判成标题”。

组合图形还有两个坐标系：`off/ext` 表示组合框在父坐标中的位置和大小，`chOff/chExt` 表示子图形内部坐标范围。Parser 递归组合平移和缩放，再把子 shape 变换到 Slide EMU 画布。旋转/翻转后的轴对齐 bbox 只是近似，因此明确给出 `PPTX_ROTATED_COORDINATE_APPROXIMATED`，不冒充像素级精确框。

表格合并属性在 `a:tc` 本身：主格用 `rowSpan/gridSpan`，延续格用 `hMerge/vMerge`。实现保留主格文字、把延续格置空，并保证矩阵至少扩展到合并范围终点。表格文本还必须进入 `textCharacterCount`；否则一页只有原生表格时会被错判为无文字页。

最后，备注、图表和 SmartArt 不是“选择器没选到就算了”。这些内容当前有意不进入 RAG 正文：备注可能涉及权限，图表/SmartArt 需要专用语义抽取。Parser 返回稳定 warning，让质量审核决定是否接受。面试中可以概括为：企业解析最危险的不是报错，而是少解析了一半却返回成功。

## 13. DOCX 为什么“第几个 media 文件”不是“第几张图片”

`word/media` 是资产仓库，不是正文目录。一个图片资产可以在封面和正文各引用一次，也可能存在已经删除但仍残留的未引用媒体。若把归档排序后的第 N 个 media 配给 Mammoth 输出的第 N 个图片，多图、重复引用和 `image2/image10` 都可能错位。

正确链路分成两层：

1. `readImageOccurrences()` 按 `word/document.xml` 的真实 XML 顺序读取 `a:blip@r:embed` 或旧式 VML 的 `r:id`。
2. 每个关系 ID 必须通过 `word/_rels/document.xml.rels` 指向存在的 `word/media` 条目；缺失时抛 `DOCX_IMAGE_RELATIONSHIP_MISSING`，不猜。
3. occurrence 保存 `paragraphIndex + drawingIndexInParagraph + anchorKind`。同一资产重复引用时 entryPath 相同，但 occurrenceIndex 和 targetId 不同。
4. Mammoth 转 HTML 时，每个图片写入只在内存使用的 `about:blank#docx-image-occurrence-N`。共用 HTML 抽取器保留这个安全 fragment，因此 IMAGE Block 能拿回精确 occurrence，同时保持在前后正文原位置。
5. OCR 返回成功后，`mergeOcrBlocks()` 查找 Parser Block 的 `metadata.ocrTargetId`，把 OCR 文字紧跟图片锚点插入。若统一追加到文档末尾，图片里的流程说明会脱离所属章节，RAG 召回时上下文就错了。

Word 的 `pageNo` 不能靠 XML 得到。DOCX 保存流式内容、样式和节设置，最终分页取决于字体、打印机度量、Word/LibreOffice 排版器。当前 Node Parser 没有执行排版，所以所有 DOCX Block 的 pageNo/bbox 明确是 null，引用使用段落/表格/图片锚点。随便按段落数估页会制造比“未知”更危险的假证据。

企业自定义标题样式也不能只看名字。Parser 读取 `styles.xml` 的 `outlineLvl`，并沿 `basedOn` 继承链解析为 H1～H6，再交给 Mammoth 和共用 HTML 抽取器。没有 outline 依据的“加粗短句”仍是正文，避免误判标题破坏 Chunk 章节路径。

页眉页脚、脚注尾注、文本框和修订必须先定发布策略：页眉水印若每页进入正文会严重重复；脚注需要正文反向锚点；文本框虽能读文字但浮动位置不精确；修订需明确接受版还是标记版。当前实现对这些存在事实给稳定 warning，让质量审核看见边界，而不是把库没抛异常等同于内容完整。

## 14. PDF 为什么“能复制文字”不等于“结构已经正确”

PDF 保存的是页面绘制指令，不是 Word 那样天然的标题、段落和表格树。同一句话可能被拆成多个 TextItem；双栏页面的对象顺序可能左右交错；粗体只是一种字体事实，不天然代表标题。因此 Parser 不能把 `page.getText()` 返回的字符串直接按换行切块。

当前链路按以下顺序恢复：

1. `PDFParse` 先完成密码、页数、元数据和矢量表格读取；Parser 复用这个锁定版本已经加载的 PDF.js 文档，不再把同一份不可信字节加载第二次。
2. 每个 TextItem 的 `transform/width/height` 经 PageViewport 映射为统一左上角坐标 bbox。CropBox 和页面 Rotate 由 viewport 一次处理，避免自己重复旋转。
3. TextItem 先按视觉基线聚成行，再根据大水平间隙拆 segment。只有左右区域都有多行且重叠范围足够时才判双栏，然后按左栏从上到下、右栏从上到下排序。
4. 同栏、相邻、字号接近且没有明显段落终止的行合成段落。`text` 用标准化空白服务检索，`originalText` 保留恢复前的真实换行供审计。
5. 标题不是只看粗体，而是综合字号相对正文、章节编号、PDF Outline、页面位置和句式；每个 TITLE 都保存 `pdf-heading-v1 + confidence + reasons + bodyFontSize`。这让误判能被解释，也让算法升级有版本边界。
6. 页眉页脚通过跨页重复事实识别为 HEADER/FOOTER。它们仍保存在 Block 中供页面展示与审计，但 Chunking 不把它们塞进每个向量，避免公司名称和页码污染召回。
7. 表格检测来自页面矢量线。匹配到表格区域的 TextItem 不再同时输出正文；匹配不可靠时保留原文并给 warning，宁可重复风险可见，也不静默删正文。

OCR 决策也不能只用“字符少于 N”。一个只有章节标题的数字 PDF 字符很少，但不是扫描失败。实现同时看原生字符数、控制字符/替换字符比例、页面是否含图以及是否完全空白：扫描页、乱码页、或“有大图且只有极少文字”的混合页才生成 PAGE Target；正常短文字页和真正空白页不会浪费 OCR，也不会用 OCR 错误覆盖可靠文字。

图片检测使用 PDF.js operator list，而不是把图片真正解码后再判断。命名 XObject 的操作数通常没有可靠像素尺寸，所以会记录 `PDF_NAMED_IMAGE_DIMENSIONS_UNAVAILABLE`；这不是漏报，而是明确告诉质量审核“知道这里有图，但当前无法证明像素预算”。如果企业要求图片级 bbox 或字形级高亮，应增加专用高精度 Adapter、升级 parser revision 并重处理，不能在现有近似能力上改一个标签冒充精确。

附件和活动动作属于安全事实，不是正文抽取。对象模型能检查时记录检查完整；对象 API 失败才用原始 token 扫描给出下限，同时把 `embeddedObjectInspectionComplete=false` 暴露出来。面试时可以总结为：企业解析的核心不是“尽量猜出结果”，而是把事实、推断、精度和未知边界分开表达。

## 15. TXT、CSV 和图片为什么也不能“读出来就算成功”

TXT 最大的坑是编码猜测。字节 `41 00 42 00` 很像无 BOM UTF-16LE，但也可能是含 NUL 的二进制；GBK 和 Big5 的同一段字节还可能解出完全不同的字。当前系统只接受严格 UTF-8、UTF-8 BOM、UTF-16LE BOM 和 UTF-16BE BOM：UTF-16 必须是偶数字节且代理项配对，无 BOM 的 NUL 输入直接拒绝。企业若确实有 GB18030 文件，应在上传契约显式声明编码并升级 Parser，而不是用概率库猜一个“看起来能读”的结果。

纯文本分段使用 `BLANK_LINE_V1`：CRLF、LF、CR 都是行边界，只有空白行才结束段落；普通单换行仍属于同一段。Block 的 `text` 把换行统一为 LF，方便 Hash/检索跨操作系统稳定；`originalText` 保留源 CRLF/LF/CR，metadata 保存起止行和编码。TXT 没有字号、样式或 Markdown 标记，因此不会把第一行臆造成标题。

CSV 看似只是 `split(',')`，实际有三层状态：引号内的逗号不是分隔符、两个双引号表示一个引号、引号内换行仍属于同一字段。实现用标准 CSV 状态机处理记录，前面只做一次轻量的引号外扫描来判断逗号、分号、Tab 或竖线。方言选择记录 `csv-delimiter-v1` 和 confidence；两种候选完全同分时使用稳定优先级但返回 `CSV_DELIMITER_AMBIGUOUS`，管理员能看到它不是确定事实。

表头也不能永远写死为第一行。`csv-header-v1` 只有在首行全部是非空唯一文本，并且后续至少一列稳定呈数值/布尔类型时才把 `headerRowCount` 设为 1；否则设为 0、保留第一行并给 `CSV_HEADER_NOT_CONFIDENT`。这是保守策略：它可能漏认全字符串表头，但不会把第一条业务数据从普通行语义中排除。固定企业模板更适合以后在知识源配置中显式指定 dialect/header，而不是全局增加中文关键词猜测。

CSV 列数不齐时，Parser 保存每行 `sourceRowWidths`，再补空字符串形成下游要求的矩形。预算器把源文件真实单元格和补齐后的展开单元格分开累计。例如 `[2,1,3,1]` 四行有 7 个真实单元格，补成 4×3 后是 12 个展开单元格；两个数字都能解释为什么触发上限。空行被解析成一个空记录并保留，不会因为 `skipEmptyLines` 悄悄消失。

图片的坑是“首图尺寸正确，文件仍可能很大”。GIF/APNG/WebP 可以有很多帧，TIFF 可以用 IFD 链保存很多页；只用首帧宽×高做像素门禁会严重低估解码成本。因此 `inspectImage()` 在不解码像素的前提下走完整 Block/Chunk/IFD 链，检查越界、循环、声明数量和帧上限，并按每个内容单元累计像素。动画需要画布合成，所以预算按完整画布×帧数，而不是局部帧矩形。

当前 OCR Target 只有 PAGE/REGION/EMBEDDED_IMAGE/WHOLE_IMAGE，没有图片内部的 frame/page 定位和逐帧 derived 资产。此时“只交给 Provider 看首帧”会导致其余内容永久丢失，且应用层还以为成功。因此当前明确拒绝多页 TIFF 和动画 GIF/APNG/WebP；未来支持时必须先做逐页/逐帧拆分、稳定 targetId、位置引用和 Provider 能力测试，再升级 revision。

EXIF/TIFF Orientation 解决的是另一个静默错误：宽 3 高 4、Orientation=6 的 JPEG 在视觉上应旋转 90°。Parser 会保留 orientation 和 `orientationApplied=false`，并返回告警；它不会只交换宽高就声称像素已旋转。内网 PaddleOCR 是否自动应用 EXIF 必须用真实样本验收。面试中可以把整段原则归纳为：输入支持矩阵不仅列“扩展名支持”，还要列编码、容器特征、定位精度、资源计费方式和不支持时的状态。

## 16. 为什么改完 Parser 不能直接覆盖旧结果

Parser 输出的是知识事实，不是随时可以刷新的缓存。今天把 CSV 第一行识别成表头，明天换成保守策略；或者 PDF 标题层级算法发生变化，同一份原文件就可能产生不同 Block、Chunk、向量和答案。如果仍写到旧对象路径，线上故障后既无法证明用户当时看的是哪套算法，也无法回滚。

这次升级按下面的顺序走：

1. `PARSER_REVISION=1.1.0` 表示解析语义已经变化，HTTP 协议仍是 v2，因为请求/响应字段没有发生破坏性变化。协议版本回答“双方能不能通信”，算法 revision 回答“同一输入会按哪套规则得到事实”，两者不能混为一个数字。
2. `DocumentProcessingService` 调用 `buildDerivedSnapshotKey()` 时同时传入 documentVersionId、contentRevision、Parser Profile 和 Parser revision，得到 `content-rN/parser-X/revision-Y/blocks.json`。对象存储 `HEAD` 只能复用四个维度都相同的快照。
3. 管理员对旧文档请求重处理时，PostgreSQL 在事务内创建新的 content revision 和 Outbox。旧 Block/Chunk 不删除，它们是回滚、审计和线上问题复盘所需的历史事实。
4. 新 revision 解析成功不等于可以上线。质量审核先检查警告、OCR 缺失和内容完整性；通过后才生成 Chunk 和候选索引。
5. 索引任务先写候选版本，再核对预期/实际向量数量、Hash 和 Profile。全部通过后只原子切换 PostgreSQL ACTIVE Head。问答请求因此只会看到完整旧版或完整新版，不会看到“半批旧向量、半批新向量”。
6. Milvus 构建失败时 ACTIVE Head 不动；回滚时只把 Head 指回历史已发布版本，不覆盖任何新旧解析事实。定位完成后可以继续修复失败候选，不需要重新从原文件猜现场。

一个常见错误是“服务启动后自动重刷全库”。这会同时放大 CPU、OCR、Embedding、Milvus 写入和人工审核压力，也会让所有知识空间一起承担新算法风险。正确做法是先部署兼容镜像、验证 readiness 的 1.1.0，再用脱敏样本小流量重处理，比较引用和答案，通过后按知识空间分批推进。

面试官问“为什么不直接覆盖”时，可以用三句话回答：解析结果是带版本的事实，不是缓存；新事实要通过质量和索引对账才能原子发布；保留旧 revision 才能让线上请求稳定、审计可解释、故障可回滚。换成医疗、合同或财务场景时，发布阈值和人工抽检会更严格，但版本隔离与原子 Head 的原则不变。
