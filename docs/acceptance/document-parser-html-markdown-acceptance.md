# HTML/Markdown 结构抽取验收记录

> 日期：2026-09-06；需求：PAR-018；共用实现同时被 DOCX 的 Mammoth HTML 输出复用。

## 已验收语义

- DOM 按子节点阅读顺序遍历；`div/section/article/body` 的直接裸文本不再丢失。
- 相邻裸文本与行内标签归属同一段；遇到子块先输出父容器自己的文本，因此不重复吸收子 Block。
- 普通 HTML 文本完成实体解码与空白折叠，只有 `<br>` 形成明确换行；`pre` 原样保留空格和换行。
- `blockquote` 通过 `semantic=BLOCKQUOTE + quoteDepth` 保留引用语义。
- 有序/无序列表记录 `listDepth/listKind/itemNumber/listMarker`；父项 own text 排除嵌套列表正文。
- 图片和说明保持阅读顺序；外链只分类和计数，HTML/Markdown Parser 仍不抓取外部图片或创建可执行 OCR 目标。
- 表格只读取当前 table 的直接行；内表单独输出并产生 `HTML_NESTED_TABLE_SEPARATED`。
- rowspan/colspan 的占位、尾部空列和跨到源文档末尾之外的空行全部补齐，合并范围不会越过输出矩阵。
- `originalText` 的定义是“实体解码后、按上述 HTML 空白语义恢复的 Parser 原文”；后续 `normalizeBlockText()` 只修改 `text`，不覆盖它。

## 自动化证据

```text
html-structure.spec.ts：6 tests passed
Parser/Chunking 联动：52 tests passed，10 snapshots passed
TypeScript strict：passed
targeted ESLint/Prettier：passed
```

回归样本覆盖裸文本、`br`、父子归属、引用、代码空白、嵌套有序/无序列表、Markdown 硬换行/围栏代码/图片、尾部跨度和嵌套表格。

## 边界

HTML 不执行脚本、不计算 CSS 布局，也不把视觉坐标伪造成 bbox。格式错误但浏览器可恢复的 HTML 以 Cheerio 解析树为事实；需要浏览器渲染后阅读顺序的网页应作为独立采集/渲染需求，不在文档 Parser 中偷偷访问公网。
