# XLSX 图片与表格事实验收记录

> 日期：2026-09-06；需求：PAR-019；测试文件全部由 ExcelJS/OOXML 在内存合成。

## 已验收语义

- `worksheet.getImages().imageId` 按 ExcelJS `workbook.model.media[index]` 解析真实 `name/extension`，不再把 0 当一基编号，也不对 ZIP 文件名字典排序。
- 同一媒体资产可出现多次；每个 drawing 位置有唯一 targetId、Sheet、原始 anchor、bbox 和 IMAGE 占位 Block，重复引用仍指向同一归档字节。
- image2/image10、第一张 imageId=0、重复引用及重命名为 picture42 的非连续媒体均有回归。
- 空白行/列把一个 Sheet 划分成多个连续业务区域；每个 TABLE 保存 `sourceRange/sourceRowNumbers/sourceColumnNumbers`。
- 合并范围先扩展 used 坐标，再映射到区域局部行列；稀疏源行压缩后 merged cell 不越界。
- 公式表达式、缓存结果和 `CACHED/MISSING` 分开保存。MISSING 的展示文本为空并产生 `XLSX_FORMULA_RESULT_MISSING`，不会把 `=1+1` 当答案写进 RAG 正文。
- 百分比、货币、千分位、日期和前导零使用确定性文本；非 General 单元格同时保留原始标量、numFmt 和 displayText。
- 表头只在“首行是文本标签且后续行出现非文本业务值”时保守推断；单行说明或纯文本区不机械认作表头。

## 自动化证据

```text
xlsx.parser.spec.ts：5 tests passed
XLSX + Parser 资源/Golden：30 tests passed，5 snapshots passed
TypeScript strict、targeted ESLint/Prettier：passed
```

## 支持边界

- 项目不执行 Excel 公式；需要最新计算值时必须由上游 Office 重新计算并保存缓存结果。
- 自定义 numFmt 只对百分比、货币、千分位、固定小数和整数前导零做确定性解释；原始 numFmt 始终保留，复杂会计/条件/本地化格式需用企业样本扩展并升级 Parser revision。
- 区域划分把完全空白行/列视为表边界。企业模板若用空白列做单表视觉间距，应通过真实样本确定是否需要显式 Named Table/配置策略，不能静默合并所有区域。
