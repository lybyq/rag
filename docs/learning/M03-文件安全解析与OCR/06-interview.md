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

业务层只依赖 `ParserPort/OcrPort` 和 Zod 结果。外网 Docling、内网 HTTP、CI Fixture 都在 Adapter 层；切换只改配置。每个 Run 保存 profileId/revision/protocol，响应漂移直接失败而不是静默兼容。

## Q6：为什么人工复核不是失败？

嵌入对象和外链未必恶意，但自动放行风险高、直接拒绝又影响业务。`MANUAL_REVIEW` 是明确的业务状态：停止进入下游、保留发现项和审计事实，等待授权角色判断。

## Q7：当前实现还有什么上线前证据缺口？

代码、契约和合成 Golden 已通过；还必须在有磁盘空间的预生产环境跑真实 ClamAV/内网 Parser/OCR、复杂脱敏 Golden、MinIO CORS/预签名、并发与 soak。不能拿 Fixture 通过代替真实解析质量。
