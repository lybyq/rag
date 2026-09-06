# PDF 结构恢复、标题与 OCR 决策验收记录

> 日期：2026-09-06；需求：PAR-022；使用锁定的 `pdf-parse 2.4.5 / PDF.js 5.4.296` 和公开合成 PDF。

## 已验收语义

- 复用 pdf-parse 已加载的 PDF.js 文档读取 TextItem `str/transform/width/height/fontName/hasEOL`；运行时能力缺失按开发缺陷失败，升级锁定依赖不能静默降级。
- bbox 由 TextItem 四角经 PageViewport 转换，自动合并 CropBox/Rotate，精度标记为 `PDF_TEXT_ITEM`；不再用平均行带伪装坐标。
- 先按视觉基线聚合、按大水平间隙拆 segment，再在有足够证据时按左栏到右栏排序；相邻同栏同字号行恢复为段落，`originalText` 保留原始换行。
- 标题推断组合正文字号比、章节编号、PDF Outline、页面位置和句式，记录 `pdf-heading-v1`、confidence、reasons、bodyFontSize；普通加粗短句不会仅凭粗体被判标题。
- PDF Info/XMP `Title` 单独存入 inspection.documentTitle，不自动生成正文 TITLE。
- 重复页眉页脚输出 HEADER/FOOTER；Chunking 已有装饰元素规则会排除它们。跨页连续正文用 `pdf-cross-page-v1` 双向标记，不跨页合并原始引用。
- 矢量表格按匹配 TextItem 行插入阅读顺序，命中的原生段落不再重复输出；匹配失败时有近似顺序告警。
- 图片 operator list 区分扫描页、混合页、空白页和正常短文字页；只有扫描、乱码、或有图且原生文字极少的混合页生成 PAGE OCR Target。
- 附件使用 PDF.js 对象模型检查并记录 complete；只有对象 API 失败时才用原始 token 作为下限并显式标记检查未完成。JavaScript/open action 形成活动内容告警。

## 自动化证据

```text
pdf.parser.spec.ts：8 tests passed
PDF + Parser/Chunking 回归：54 tests passed，10 snapshots passed
TypeScript strict、targeted ESLint/Prettier：passed
```

## 支持边界

- 标题和分栏属于可解释启发式，不等于 PDF/UA 标签真相；真实企业样本必须统计误判/漏判后再调整阈值并升级 parser revision。
- 命名图片 XObject 可判断“页面含图”，但 operator args 不带可靠宽高，因此产生 `PDF_NAMED_IMAGE_DIMENSIONS_UNAVAILABLE`；像素预算只累计能够安全取得尺寸的内联对象。
- 复杂无边框表格、跨页表格、合并单元格和异形表格可能无法由矢量网格检测器恢复；不会静默删除原生文字。
- 当前读取 pdf-parse 锁定版本持有的 PDF.js 文档，是为避免再次加载同一 PDF 和引入第二套 Parser；版本升级必须先通过 `PDFJS_INTERNAL_API_MISMATCH` 相关构建/回归门禁。
