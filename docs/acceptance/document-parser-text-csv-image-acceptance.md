# TXT、CSV 与图片能力边界验收记录

> 日期：2026-09-06；需求：PAR-023；样本全部由测试代码公开合成。

## 已验收语义

- TXT 只接受严格 UTF-8、UTF-8 BOM、UTF-16LE BOM 和 UTF-16BE BOM；奇数字节 UTF-16、未配对代理项、非法 UTF-8 和含 NUL 的疑似二进制明确拒绝。
- TXT 识别 CRLF、LF、CR；空白行分段、单换行留在同段。`text` 统一成 LF，`originalText` 保留原始换行，metadata 保存行号、编码和 `BLANK_LINE_V1`。纯文本不推断 TITLE。
- CSV 在引号外扫描逗号、分号、Tab、竖线，用 `csv-delimiter-v1` 恢复方言；歧义形成 warning。引号、双引号转义和引号内跨行继续由标准 CSV 状态机解析。
- CSV 表头使用 `csv-header-v1` 的保守证据：首行非空唯一文本，且后续至少一列有稳定数值/布尔类型证据；证据不足时 `headerRowCount=0`，不删除首行，并给 warning。
- CSV 不规则行保存 `sourceRowWidths`，输出前补成矩形并分别累计真实/展开单元格；真正的空记录被保留并计数，损坏引号不返回部分表格。
- 独立图片入口完整扫描白名单容器的页/帧链：TIFF IFD、GIF Block、APNG Chunk 和 WebP RIFF/ANMF；循环、越界、声明不一致或超帧上限稳定失败。
- 当前版本没有安全的帧/页拆分产物契约，因此多页 TIFF 和动画图片明确返回 `IMAGE_MULTIPAGE_TIFF_UNSUPPORTED` / `IMAGE_ANIMATION_UNSUPPORTED`，不会只入库首页/首帧。
- 像素预算在“不支持”判断前按全部页/帧累计；GIF/APNG/WebP 动画按完整合成画布计，避免局部帧低估。
- JPEG/PNG/WebP EXIF 与 TIFF Orientation 被保留；方向不为 1 且 Parser 未旋转像素时返回 `IMAGE_ORIENTATION_NOT_APPLIED`，损坏方向元数据返回检查不完整告警。

## 自动化证据

```text
textual-image-boundaries.spec.ts：13 tests passed
document-parser-core + Parser Core：77 tests passed，5 snapshots passed
TypeScript strict、targeted ESLint/Prettier：passed
```

## 明确不支持

- 无 BOM 的 UTF-16、GBK/GB18030/Big5 等编码不会自动猜测；需要时应通过上传契约显式声明并增加 Adapter/revision，而不是用概率猜码。
- 当前 CSV 不支持通过请求参数强制覆盖分隔符或表头；歧义方言会保留 warning。若企业数据源有固定模板，应在接入配置中增加受控 dialect，而非修改全局启发式。
- 动画 GIF/APNG/WebP、多页 TIFF 不进入 OCR。要支持它们，必须先生成逐页/逐帧 derived 资产、为每个目标提供稳定 ID/页帧位置并明确 OCR Provider 能力。
- EXIF Orientation 当前只保留事实，没有在 Parser 内重编码像素；真实 OCR Provider 是否自动应用方向属于内网验收项。
