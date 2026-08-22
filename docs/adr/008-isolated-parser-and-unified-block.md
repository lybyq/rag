# ADR-008：隔离 Parser、按页 OCR 与统一 DocumentBlock

## 状态

Superseded in part by [ADR-011](./011-node-parser-and-builtin-content-safety.md)，2026-08-22。隔离、按需 OCR、统一 Block 和派生快照决策仍有效。

## 背景

上传文件是不可信输入。PDF、Office 和压缩容器可能包含恶意载荷、宏、外链、嵌入对象、压缩炸弹或触发 Parser 漏洞。把 Parser 库直接装进 Platform API 会让攻击面、CPU/内存峰值和在线请求处于同一故障域；把所有 PDF 都 OCR 又会显著增加延迟并破坏可靠文字层。

外网开发需要免费开源能力，内网已有 OCR 服务且接口尚未冻结。因此领域层不能依赖 Docling、PaddleOCR 或某个云厂商的响应结构。

## 决策

1. 原始文件只存放在隔离 Bucket；安全门禁通过前不得进入发布链路。
2. Worker 流式计算可信 SHA-256、识别魔数并调用可插拔扫描 Port；扫描异常按失败处理，绝不 fail-open。当前默认实现见 ADR-011。
3. Parser 与 OCR 分别定义 Port。外网 Parser Adapter 对接 Docling Serve 稳定 v1 API；内网可切换标准 HTTP Adapter。API Key、Endpoint 和 Profile 全部由配置注入。
4. Parser Runtime 独立部署，禁止公网出站，使用只读根文件系统、非 root 用户、CPU/内存/临时盘和绝对超时限制。预签名读取 URL 只在内存中传递，不写日志和数据库。
5. PDF 先执行原生解析，再逐页计算文字覆盖率；只有低覆盖或纯图片页进入 OcrPort。OCR 结果必须包含页码、归一化坐标、置信度和引擎版本。
6. 所有 Parser/OCR 输出先映射为统一 `DocumentBlock`。`originalText` 永久保留，标准化文本写入 `text`，同一内容修订内 ordinal 和 Block ID 稳定。
7. Block Snapshot 写入版本化 derived 路径并保存 SHA-256。数据库提交失败后，重试先校验并复用快照，避免再次执行昂贵 Parser/OCR。
8. M03 只产出 Block；Chunk、质量结论和人工审核属于 M04。

## 取舍

- Docling 本地镜像较大，因此不在 C 盘已满的当前机器拉取；Adapter、契约和故障测试可以先完成，真实样本评测必须在 D 盘 Docker data-root 或 CI 运行。
- 外网 Docling 可以同时提供 OCR，但系统仍保留独立 OcrPort，以适配内网页级 OCR 服务并避免供应商结构泄漏。
- 派生 JSON Snapshot 增加一份对象存储成本，换取可重放、可审计和故障窗口内的幂等复用。

## 参考

- Docling Serve v1：`POST /v1/convert/source`，支持 URL 输入、JSON 输出及 OCR 配置。
- 当前扫描和 Parser 替代决策见 [ADR-011](./011-node-parser-and-builtin-content-safety.md)。
