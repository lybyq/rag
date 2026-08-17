# 04｜测试：哪些 Fake 可以信，哪些不能

## 自动化分层

| 层              | 本模块证据                              | 能证明               | 不能证明            |
| --------------- | --------------------------------------- | -------------------- | ------------------- |
| 领域单测        | magic/MIME、安全阈值、OCR 选页、稳定 ID | 规则确定性           | 真实文档质量        |
| Port 契约       | clamd 响应、HTTP 429、Schema/版本漂移   | Adapter fail closed  | 远端服务部署正确    |
| 编排单测        | 流式 SHA、恶意拒绝、低页 OCR、快照      | 调用顺序和副作用边界 | MinIO/PG 网络行为   |
| Golden Snapshot | 九类格式固定路由与统一结构              | 协议回归             | 复杂排版准确率      |
| Vue 测试        | 安全结论/Profile/OCR/耗时               | 关键事实可见         | 浏览器端到端网络    |
| 集成/预生产     | 真实 PG/MinIO/ClamAV/Parser/OCR         | 部署和协议兼容       | 长期容量，需要 soak |

## 为什么 Fixture 不能做质量结论

Fixture 的价值是可预测、快速和不依赖个人密钥；它会对所有文本格式返回固定 Block，因此无法回答“复杂 Excel 合并表头是否正确”或“低质量扫描件 OCR 准确率是否足够”。生产启动会拒绝 Fixture，验收报告必须区分契约通过与真实 Provider 通过。

## Golden 升级流程

1. 固定脱敏文档、预期 Block 和 Provider revision。
2. 升级 Adapter/Provider 后生成候选差异。
3. 人工解释每个顺序、文本、表格、bbox、置信度变化。
4. 只有确认是改进时才更新 Snapshot，同时创建新 Profile revision。
5. 旧 Run 不回写新含义。

常用命令：

```powershell
$env:TEMP='D:\codex-temp\rag-m03'
$env:TMP='D:\codex-temp\rag-m03'
pnpm exec jest --runInBand libs/parser-core libs/file-processing-providers libs/application/src/document-processing.service.spec.ts
pnpm test
pnpm check
```
