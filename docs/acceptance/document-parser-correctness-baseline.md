# Parser 内容正确性优化：阶段 0 基线记录

## 执行信息

- 日期：2026-09-05
- 工作区：`D:\coding\rag`
- 临时目录：`D:\codex-temp\rag-parser-optimization`
- 范围：Parser、OCR Adapter、解析编排、Parser Core、Chunking
- 说明：只记录优化前状态；不把尚未执行的内网 PaddleOCR 或企业文档验证写成通过。

## CodeGraph 影响范围

- 主链路：`DocumentProcessingService.process()` → `ParserPort/OcrPort` → `selectOcrTargets()` → `mergeOcrBlocks()` → `buildDocumentBlocks()` → Snapshot/Repository → Chunking。
- `mergeOcrBlocks()` 的生产调用者只有 `DocumentProcessingService`。
- Parser/OCR 契约被 HTTP Adapter、Parser Service、Fixture/Docling Adapter、持久化和管理 API 共同使用，协议修改影响面大，因此阶段 0 决定保持 protocol v2。

## 基线命令

```powershell
$env:TEMP='D:\codex-temp\rag-parser-optimization'
$env:TMP=$env:TEMP
$env:NODE_OPTIONS='--experimental-vm-modules'
pnpm exec jest --runInBand libs/document-parser-core libs/parser-core libs/file-processing-providers libs/chunking libs/application/src/document-processing.service.spec.ts
```

## 基线结果

```text
Test Suites: 8 passed, 8 total
Tests:       60 passed, 60 total
Snapshots:   19 passed, 19 total
Time:        23.265 s
```

通过的套件：

- `libs/document-parser-core/src/document-parsers.spec.ts`
- `libs/parser-core/src/parser-core.spec.ts`
- `libs/parser-core/src/golden-formats.spec.ts`
- `libs/file-processing-providers/src/provider-adapters.spec.ts`
- `libs/application/src/document-processing.service.spec.ts`
- `libs/chunking/src/chunking-core.spec.ts`
- `libs/chunking/src/golden-chunks.spec.ts`
- `libs/chunking/src/review-policy.spec.ts`

## 已知未覆盖项

当前绿灯只能证明旧行为稳定，不能证明 `PAR-016`～`PAR-024` 已完成。阶段 1 必须先把 OCR 空结果仍删除原生页、缺失/重复/错位结果等已确认问题写成失败测试。真实 PaddleOCR、企业复杂 Office/PDF、Parser kill 恢复、中型规模并发和 soak 仍属于内网/预生产门禁。

## 阶段 0 验收

- [x] 新需求编号与验收条件已加入需求基线。
- [x] ADR-016 已记录四类核心决策。
- [x] CodeGraph 调用链和影响面已记录。
- [x] Parser/OCR/Chunking 基线测试已记录。
- [x] protocol、revision、Profile 和 Snapshot 版本结论已明确。
- [x] 实施顺序与收敛原则已明确。
