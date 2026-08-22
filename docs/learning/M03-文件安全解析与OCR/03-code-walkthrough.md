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
5. 最后 `ParserResultSchema.safeParse()` 是内部实现的最后一道防线。某个 Parser 漏字段或产生非法 bbox 会转成 `PARSER_OUTPUT_SCHEMA_MISMATCH`，不会污染 M04。

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

## 7. OCR Target 合并为什么“原生优先”

`selectOcrTargets()` 合并 Parser 图片候选与 PDF 覆盖率页，`targetId` 去重并稳定排序。`mergeOcrBlocks()` 只有在 Target.kind 为 PAGE 时删除该页低可靠原生块；REGION、EMBEDDED_IMAGE、WHOLE_IMAGE 只补充。否则一张截图 OCR 会错误删除同一 PPT 页上的可靠文本框。

`buildDocumentBlocks()` 只在候选 metadata 的 `extractionSource` 为 OCR/MERGED 时写 `ocrEngine/ocrRevision`。同一文档调用过 OCR，不代表所有原生 Block 都来自 OCR。

## 8. 最终事务和故障传播

安全结论为 REJECTED 或 MANUAL_REVIEW 时不会进入 M04。成功路径写版本化 `blocks.json`，SHA 相同可复用；PG `complete()` 在一个事务内写 Block、Issue、Run 和任务步骤。每次提交前再次检查 lease，旧 Worker 即使晚到也不能覆盖新 Worker。

错误分类：确定性坏文档不重试；网络/429/5xx/Deadline 有限重试；Schema/revision/内部不变量错误进入开发缺陷。日志只记录稳定 code 和 Trace，不记录正文、预签名 URL 或密钥。
