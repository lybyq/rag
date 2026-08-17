# 07｜动手练习

## 练习 1：解释一次正常 PDF 的完整路径

从 Outbox event 开始，按源码顺序写出 Inbox、lease、MinIO stream、ClamAV、格式识别、Parser、OCR 选页、Block、derived 和 PG 状态变化。要求说明每一步失败后 Job 会处于什么状态。

## 练习 2：新增 TIFF 多页限制

只修改领域/Provider 契约和测试，不把规则写进 Controller。设计页数、像素和 OCR 页的关系，并说明为何 `totalPixels` 需要独立上限。

## 练习 3：实现内网 Parser Adapter 契约服务

实现 `/v1/parse`，返回完整 `ParserResultSchema`。故意删除 `inspection.hasMacros`、改协议版本、改 revision，观察平台如何分别报 `PARSER_SCHEMA_MISMATCH`、`PARSER_PROTOCOL_VERSION_MISMATCH`、`PARSER_REVISION_MISMATCH`。

## 练习 4：验证 lease fencing

让 Worker A 领取任务后停止续租；等待 Scheduler 重排并由 Worker B 领取。再让 A 尝试提交，验证 PG 返回 `INVALID_STATE`，B 的结果未被覆盖。

## 练习 5：建立真实 Golden

准备九类脱敏文件，至少包含：文本/扫描混合 PDF、Excel 合并表头、PPT 图文、低置信图片、密码文件、含外链 Office。记录每份文件的预期 Block、页/Sheet/Slide 和 bbox，再用内网 Provider Profile 跑差异。

## 自测标准

你能不看文档回答以下问题才算真正掌握：

- 为什么 Inbox 去重不能代替处理幂等？
- 为什么短时 URL 也不能写日志？
- 为什么 Docling 外网联调可用，但不能直接作为生产安全门禁？
- 什么时候重试，什么时候拒绝，什么时候人工复核？
- 为什么 derived 对象成功而 PG 失败仍然可安全恢复？
