# Parser 统一资源预算验收记录

> 日期：2026-09-06；需求：PAR-017；范围仅限 Node Parser Core 与独立 Parser Service。

## 1. 已验收能力

- 九类格式共享 `ParseResourceBudget`，累计真实/展开单元格、最大行列、合并跨度、输出字符和已知图片像素。
- HTML/Markdown/DOCX 共用抽取器接收同一预算和取消上下文；rowspan/colspan 在创建 occupied 占位前检查。
- CSV 在 `csv-parse` 的 `onRecord` 回调中累计行列和单元格，不等完整二维数组构造完才拒绝。
- XLSX 在 `includeEmpty: true` 前检查稀疏远端坐标；PPTX/PDF 在表格补齐和 Block 字符串创建前检查。
- 所有累计加法、矩形面积和跨度乘法使用安全整数检查；超限返回稳定 `*_LIMIT_EXCEEDED`，不截断正文。
- Parser HTTP 父线程把每个文档交给短生命周期 Worker Thread。Deadline、客户端断开或任务取消会 `terminate()` 当前 Worker；并发满载返回可重试 503，不在内存排队完整文件。
- 成功调用输出四组低基数容量指标：输出字符、真实表格单元格、展开单元格和已知像素；标签只有格式枚举。

## 2. 第三方库边界

ExcelJS、Mammoth、Cheerio、markdown-it 和 pdfjs 的部分读取过程由第三方库一次性物化，无法在库内部每次分配前插入项目预算。本项目采用三层边界：调用前字节/ZIP/XML 上限、调用后的统一预算核对、外层可终止 Worker。Worker 再由 Compose 的 2 GiB 内存、2 CPU、只读文件系统和 tmpfs 限制兜底。

这不是声称第三方库“完全流式”。容量调优必须用企业脱敏样本做压测；超过门禁时调整 Profile 并升级 Parser revision，禁止对单个文件临时绕过。

## 3. 自动化证据

```text
TypeScript strict：通过
PAR-017 预算/配置/Worker/Controller：31 tests passed
Node Parser Golden/security：21 tests passed，5 snapshots updated and passed
document-parser-service webpack production build：通过
真实编译 bundle Worker smoke：TEXT 返回 ok=true、revision/text 正确
```

永久回归包含：跨度展开超限、安全整数、大行数 CSV、输出字符超限、调用前取消、XLSX 稀疏远端列、Worker 硬取消、并发背压、跨线程错误分类和容量指标。

## 4. 仍需内网补跑

- 用企业脱敏 PDF/Office 样本校准五个新增 `FILE_MAX_*` 预算及 `PARSER_MAX_CONCURRENCY`。
- 在容器内压测 Deadline 触发后的 Worker 回收、进程 RSS 回落和 BullMQ 有限重试。
- 验证 2 CPU/2 GiB 默认资源下的中型规模吞吐与 8 小时 soak。

这些环境证据不影响仓库级 PAR-017 实现完成，但不能据此宣称内网容量验收已经通过。
