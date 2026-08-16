# M02 练习：从会用到能独立设计

## 练习 1：手推状态机

给出以下转换，判断是否合法并说明恢复方式：

1. DocumentVersion `UPLOADING → SUCCEEDED`
2. Job `RUNNING → QUEUED`
3. Job `FAILED → QUEUED`
4. Step `SUCCEEDED → RUNNING`

参考方向：正常业务跳转与 Scheduler 恢复不是一回事；恢复必须经过专门的 lease 规则和 attempt 记录，不能开放任意状态倒退。

## 练习 2：计算真实进度

已知 SECURITY_SCAN 权重 8%、PARSE 权重 20%。安全扫描成功，解析处理 30/100，其余未开始。计算 overall。

答案：`8 + 20 × 30% = 14%`。如果解析 total 未知，则 overall 只能是 8%。

## 练习 3：设计故障注入

分别在下列位置模拟进程崩溃，并写出重试后必须成立的不变量：

1. Multipart 合并成功后、HEAD 前；
2. HEAD 成功后、PG BEGIN 前；
3. Document 插入后、Outbox 插入前；
4. BullMQ add 成功后、mark published 前；
5. Consumer 插入 Inbox 后、状态更新前。

检查你的答案是否依赖一个并不存在的跨系统事务。

## 练习 4：读 SQL 锁

解释以下两个锁解决的竞态不同在哪里：

```sql
SELECT ... FROM upload_files WHERE id = $1 FOR UPDATE;

SELECT id FROM outbox_events
FOR UPDATE SKIP LOCKED
LIMIT 50;
```

提示：第一个让同一资源串行化；第二个让多个 Publisher 分摊不同资源。

## 练习 5：扩展允许 MIME

增加配置 `UPLOAD_ALLOWED_CONTENT_TYPES`，要求：

- Zod 配置校验；
- 创建会话早拒绝；
- Complete HEAD 再核对；
- 错误不泄露内部 bucket/key；
- 添加成功、拒绝和大小写边界测试。

不要把扩展名当成可信 MIME；M03 仍需魔数交叉验证。

## 练习 6：实现断点续传 UX

当前刷新能恢复会话，但浏览器不能恢复 File Blob。设计一个安全 UX：用户重新选择同名文件后，至少核对 size、lastModified 和可选浏览器 SHA-256，再只上传服务端列出的缺失分片。

思考：为了列出缺失分片，ObjectStoragePort 与 API 需要增加什么契约？如何避免泄露其他用户的 uploadId？

## 练习 7：做一次面试白板讲解

限制 8 分钟，画出：

1. 浏览器、API、MinIO、PG、Scheduler、BullMQ、Worker；
2. 上传和完成两条时序；
3. MinIO 成功/PG 失败窗口；
4. Outbox/Inbox；
5. lease/heartbeat。

讲完后让同伴追问：“如果这一步刚好崩溃呢？”每个回答都必须落到稳定 ID、数据库约束、重试或人工状态之一。

## 练习 8：生产验收设计

为中型规模写一个测试矩阵，至少包含：

- 100 文件并发；
- 200 MiB 和 2 GiB 边界；
- 1% 分片随机失败；
- 预签名过期；
- MinIO/PG/Redis 分别中断；
- Worker 在每个步骤随机退出；
- 浏览器刷新与代理断 SSE；
- 同一 Complete 并发 20 次；
- 撤权后继续读取任务事件。

输出 SLO、资源曲线、重复事实数和人工 WAITING 数，而不只记录“接口成功率”。
