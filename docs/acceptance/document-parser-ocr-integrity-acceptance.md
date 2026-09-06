# Parser OCR 内容完整性：阶段 1 验收

## 需求

`PAR-016`：逐目标校验 OCR 完整性、唯一性、定位和质量。只有可靠 PAGE 结果替换原生页；其他结果必须保留原生内容、形成可见 Issue，并在主要正文不可靠时阻止进入 Chunk/索引。

## 实现证据

- `libs/parser-core/src/block-normalization.ts`：正常短页选择、格式约束、Provider 能力过滤、逐目标质量状态和安全合并。
- `libs/file-processing-providers/src/http-ocr.adapter.ts`：重复请求、重复/额外响应、页/Slide/Sheet 冲突校验和缺失结果标记。
- `libs/application/src/document-processing.service.ts`：Issue、人工审核判定和 `ocrOutcomeCounts`。
- `libs/persistence-pg/src/postgres-document-processing.repository.ts`：同一事务保存 Block/Issue/Snapshot 并转 WAITING，不创建 Chunk Outbox。
- `libs/config/src/app-config.ts`：兼容新增 `OCR_CAPABILITIES`；不改变现有 OCR URL、认证、Profile 和 protocol v2。

## 自动化结果

```text
TypeScript strict typecheck: passed
ESLint（阶段 1 变更文件）: passed
Parser/OCR/Chunking: 8 suites, 69 tests, 19 snapshots passed
阶段 1 定向测试: 3 suites, 22 tests passed
PostgreSQL document parsing integration: 2 tests passed
```

覆盖：空结果、缺失、重复请求、重复响应、额外目标、错误页码、位置补齐、低置信、部分成功、纯扫描页、正常短标题页、图片补充、Provider 能力收窄、429 有限重试、调用方取消、lease fencing 和无 Chunk Outbox。

## 可观测性

- 单目标问题写 Parse Issue，包含稳定 code、targetId、targetKind、页码和必要阈值，不保存正文或供应商原始响应。
- Run metrics 写低基数 `ocrOutcomeCounts`；targetId 不进入指标标签。
- 主要正文不可靠时 Run/Job/DocumentVersion/NORMALIZE 均为 WAITING，管理端可沿现有解析详情接口查看。

## 未冒充通过的项目

- 本轮没有访问用户内网，修订后的 Adapter 尚未对真实 PaddleOCR 重放。
- 内网应使用同一批脱敏样本复验 PAGE、EMBEDDED_IMAGE、WHOLE_IMAGE 的 targetId、位置、置信度和取消行为。
- PDF 混合页判断需要阶段 7 的版面事实，当前只自动选择确定无原生文字的页。

## 结论

- [x] 代码完成。
- [x] 单元、契约和 PostgreSQL 事务测试完成。
- [x] Issue、Run metrics 和 WAITING 状态可观测。
- [x] 教学文档和验收证据完成。
- [x] 内网兼容边界已记录，未修改 HTTP 路径和 protocol v2。
