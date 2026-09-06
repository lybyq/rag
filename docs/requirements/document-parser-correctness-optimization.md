# Parser 内容正确性与结构恢复优化计划

> 实施状态：已完成（2026-09-06）。Parser 算法 revision 已统一升级到 `1.1.0`；`PAR-016`～`PAR-024` 的代码、自动化测试、验收清单和教学说明均已落库。真实 PaddleOCR、企业脱敏样本和容量压测仍按内网门禁单独验收，不能用合成测试冒充。

## 1. 目标与边界

本轮只优化现有 Node/TypeScript Parser、OCR 合并和下游结构事实。继续使用独立 `document-parser-service`、现有 Port/Adapter 分层和配置项，不引入第二套 Parser 服务，不修改已经联调通过的 Provider 地址、认证方式和环境变量语义。

需求依据为 `PAR-016`～`PAR-024`，架构结论见 ADR-016。代码、测试、指标、教学文档和验收证据同时完成后才能勾选需求。

## 2. CodeGraph 调用链基线

2026-09-05 使用 CodeGraph 追踪到的主链路如下：

```text
ingestion-worker
  -> DocumentProcessingService.process()
  -> ParserPort.parse()
  -> HttpParserAdapter / document-parser-service / ParserRegistry
  -> 格式 Parser 输出 blocks、pages、ocrCandidates、inspection、warnings
  -> selectOcrTargets()
  -> OcrPort.recognize() / HttpOcrAdapter
  -> mergeOcrBlocks()
  -> buildDocumentBlocks()
  -> derived Snapshot + PostgreSQL complete()
  -> Chunking 读取统一 DocumentBlock
```

直接影响面：`mergeOcrBlocks()` 只有 `DocumentProcessingService` 一个生产调用者；Parser 契约同时被 HTTP Adapter、Parser Service、Fixture/Docling Adapter、持久化和管理端读取。为了收敛变更，先在纯函数与 Adapter 边界修复，再调整格式 Parser，最后统一升级 revision。

## 3. 需求映射与实施顺序

| 阶段 | 需求         | 修改范围                                                      | 主要验收                                 |
| ---- | ------------ | ------------------------------------------------------------- | ---------------------------------------- |
| 0    | PAR-016～024 | 需求、ADR、调用链、基线、版本结论                             | 本文、ADR-016、基线记录齐全              |
| 1    | PAR-016      | contracts、HttpOcrAdapter、block-normalization、应用编排      | OCR 异常不删除原生内容，不绕过质量门禁   |
| 2    | PAR-017      | Parser limits、预算器、HTML/Markdown/CSV/Office/PDF/图片      | 小预算下有界完成或稳定失败               |
| 3    | PAR-018      | html-structure、textual parsers、DOCX 共用调用                | 阅读顺序正确，正文不漏不重，表格坐标一致 |
| 4    | PAR-019      | XLSX OOXML relationship、单元格与图片事实                     | 图片字节/锚点正确，公式和源坐标可追溯    |
| 5    | PAR-020      | PPTX presentation relationships、Run、表格和告警              | 重排或编号空洞时页序、引用和文本仍正确   |
| 6    | PAR-021      | DOCX drawing relationship、出现位置与内容锚点                 | 多图 OCR 不错位，不伪造物理页码          |
| 7    | PAR-022      | PDF TextItem、标题推断、阅读顺序、装饰去重、表格/OCR 决策     | Golden 与 Chunking 标题路径同时通过      |
| 8    | PAR-023      | TXT、CSV、图片格式能力边界                                    | 不支持输入明确拒绝或告警，不静默少解析   |
| 9    | PAR-024      | revision、配置样例、快照/重处理、质量审核、索引发布和最终文档 | 新旧版本隔离、可回滚、全量门禁通过       |

阶段 1～8 每次只修改当前格式或共用层，先写失败测试再实现。某一阶段未通过，不进入依赖它的下一阶段。

## 4. 协议与版本结论

- Parser/OCR HTTP 协议继续使用 `2`，阶段 0 不新增内网必填字段。
- Parser/OCR Profile ID 和环境变量名保持不变。
- Parser revision 在阶段 9 从 `1.0.0` 统一升级到 `1.1.0`，不会在中间阶段发布半成品 revision。
- OCR Provider revision 仍由真实内网服务提供；Adapter 校验增强不冒充 Provider 升级。
- Snapshot 结构仍为 `document-blocks/v1`；revision 和内容进入快照 Hash，新 revision 必须新建 content revision 重处理。

## 5. 收敛原则

1. 不改变现有 HTTP 路径、认证头、Provider 地址和 Docker 服务名。
2. 不把供应商私有字段放进 Domain；差异只在 Adapter 映射。
3. 不用静默截断换取“解析成功”；超限、错位和能力缺失必须返回稳定错误或 Issue。
4. 不在真实内网验证前勾选 PaddleOCR、企业模板、并发容量相关门禁。
5. 每阶段保留旧 Golden，并新增最小合成复现，避免一次性刷新快照掩盖内容回归。
