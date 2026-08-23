# 07｜动手练习

## 练习 1：解释一次正常 PDF 的完整路径

从 Outbox event 开始，按源码顺序写出 Inbox、lease、MinIO stream、内置 Scanner、格式识别、Node Parser、OCR Target、Block、derived 和 PG 状态变化。要求说明每一步失败后 Job 会处于什么状态。

## 练习 2：新增 TIFF 多页限制

只修改领域/Provider 契约和测试，不把规则写进 Controller。设计页数、像素和 OCR 页的关系，并说明为何 `totalPixels` 需要独立上限。

## 练习 3：扩展 Node Parser 契约服务

在现有 `/v1/parse` 中新增一种格式 Parser，返回完整 `ParserResultSchema`。故意删除 `inspection.hasMacros`、改协议版本、改 revision，观察 Registry 和平台 HTTP Adapter 如何分别 fail closed。

## 练习 4：验证 lease fencing

让 Worker A 领取任务后停止续租；等待 Scheduler 重排并由 Worker B 领取。再让 A 尝试提交，验证 PG 返回 `INVALID_STATE`，B 的结果未被覆盖。

## 练习 5：建立真实 Golden

准备九类脱敏文件，至少包含：文本/扫描混合 PDF、Excel 合并表头、PPT 图文、低置信图片、密码文件、含外链 Office。记录每份文件的预期 Block、页/Sheet/Slide 和 bbox，再用内网 Provider Profile 跑差异。

## 自测标准

你能不看文档回答以下问题才算真正掌握：

- 为什么 Inbox 去重不能代替处理幂等？
- 为什么短时 URL 也不能写日志？
- 为什么内置 Scanner 不等价于病毒库，结构安全检查又为什么必须保留？
- 什么时候重试，什么时候拒绝，什么时候人工复核？
- 为什么 derived 对象成功而 PG 失败仍然可安全恢复？
