# DOCX 图片定位与结构边界验收记录

> 日期：2026-09-06；需求：PAR-021；测试使用最小真实 OOXML 与公开 1×1 PNG。

## 已验收语义

- 正文图片从 `word/document.xml` 的 `a:blip@r:embed` / `v:imagedata@r:id` 读取，再通过 `word/_rels/document.xml.rels` 找到真实 `word/media`；关系缺失时 fail closed，不按归档文件排序猜测。
- “媒体资产”和“出现位置”分离：同一关系重复三次会得到三个稳定 targetId、三个 IMAGE Block，但像素预算只按唯一资产累计。
- 图片 Block 保存 `paragraphIndex/drawingIndexInParagraph/anchorKind/relationshipId/archiveEntryPath/ocrTargetId`，仍位于 Mammoth 恢复的前后正文之间。
- 成功的 EMBEDDED_IMAGE OCR 根据 `ocrTargetId` 紧跟对应 IMAGE Block 插入，不再统一追加到文档末尾。
- DOCX 未经 Word 排版不伪造物理 `pageNo` 和 `bbox`；引用使用正文段落/表格/图片锚点。
- `styles.xml` 中企业自定义段落样式可通过 `outlineLvl`（含 basedOn 继承）恢复标题；Mammoth + 共用 HTML 抽取器继续处理标准标题、嵌套编号列表和合并表格。
- 页眉页脚、脚注尾注、文本框、修订、altChunk、未知图片尺寸/格式和未引用媒体都有稳定边界告警。

## 自动化证据

```text
docx.parser.spec.ts：6 tests passed
DOCX + Parser/OCR 回归：35 tests passed，5 snapshots passed
TypeScript strict、targeted ESLint/Prettier：passed
```

## 支持边界

- 当前正文视图遵循 Mammoth：修订插入内容可见、删除内容不作为当前正文；出现修订标记时仍要求质量审核确认业务期望。
- Mammoth 能读取文本框文字，但不提供浮动层叠、旋转和精确阅读位置，所以标记 `DOCX_TEXTBOX_SUPPORT_PARTIAL`。
- 页眉页脚默认不发布，防止模板名称、密级水印反复污染每个 Chunk；脚注尾注未建立与正文 Block 的双向锚点前也不宣称完整支持。
- EMF/WMF 等非白名单图片仍保留关系与 occurrence，但尺寸不可验证、MIME 为 null，并产生告警；OCR Provider 是否支持必须由 Profile 能力和真实内网样本验收。
