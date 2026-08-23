# 06｜面试追问与回答骨架

## Q1：为什么不能只信 MIME？

MIME 和扩展名来自客户端，都可伪造。我们以魔数/内容为主，再交叉校验扩展名和声明 MIME；流式扫描同时重算 SHA 和大小，防止上传完成后对象被替换。

## Q2：Parser 都在容器里了，为什么还要杀超时？

容器隔离降低权限和爆炸半径，不代表任务会自动结束。畸形文档可能导致 CPU/内存长期占用，所以调用必须有绝对 Deadline、Abort、容器资源上限和 lease 续租；超时归类为可重试 Provider 故障，达到上限转人工。

## Q3：怎样避免旧 Worker 覆盖新 Worker？

不是只靠消息去重。每次写安全事实、步骤或最终结果前，PG 都校验 `status=RUNNING + lease_owner + lease_expires_at>now()` 并行锁；失去 lease 的旧 Worker 无法提交。这相当于数据库侧 fencing。

## Q4：为什么 Block 和 Chunk 分开？

Block 是解析层的可定位事实，Chunk 是检索策略产物。Chunk 长度、重叠和标题继承会迭代；如果 Parser 直接产 Chunk，每次检索策略调整都要重新跑昂贵 OCR/版面解析，也更难复现引用。

## Q5：你们怎样做到 Parser 可替换？

业务层只依赖 `ParserPort/OcrPort` 和 Zod 结果。内外网默认 Node Parser、可选 Docling、内网 HTTP OCR、CI Fixture 都在 Adapter/独立服务层；切换只改配置。每个 Run 保存 profileId/revision/protocol，响应漂移直接失败而不是静默兼容。

## Q6：为什么人工复核不是失败？

嵌入对象和外链未必恶意，但自动放行风险高、直接拒绝又影响业务。`MANUAL_REVIEW` 是明确的业务状态：停止进入下游、保留发现项和审计事实，等待授权角色判断。

## Q7：为什么删了外置病毒库服务仍不能说“安全能力完全等价”？

内置规则能流式拒绝 EICAR、常见可执行魔数和超限输入，Parser 能检查 Office 宏/外链/嵌入对象/压缩炸弹；但它没有持续更新的病毒特征、沙箱行为分析或信誉库。因此还要依靠来源权限、隔离容器、SCA/SBOM，并保留将来接企业扫描服务的 Port。诚实说明能力边界比把 CLEAN 夸成“无病毒”更符合生产设计。

## Q8：为什么 OOXML 不能直接交给 Mammoth/ExcelJS？

第三方库一打开 ZIP 就可能解压。我们先用 lazy entry 流检查路径、条目数、加密和解压比，只保存必要 XML/媒体，确认内部核心部件唯一后再调用内容库。顺序反过来时，压缩炸弹会在安全 inspection 产生之前消耗资源。

## Q9：当前实现还有什么上线前证据缺口？

代码、协议和公开合成 Golden 已通过；仍需用企业脱敏模板跑真实 PaddleOCR、MinIO/DNS、复杂 PDF 字形级引用需求、中型并发与 8 小时 soak。当前 PDF bbox 明确是页内行序近似；若业务要求像素级高亮，必须升级 PDF Adapter/revision，不能拿近似坐标冒充。
