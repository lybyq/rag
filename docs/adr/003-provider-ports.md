# ADR-003：内外网模型与基础设施 Provider 端口

- 状态：Accepted
- 日期：2026-08-15
- 关联需求：CFG-001～CFG-013、BASE-004

## 背景

外网开发使用 DeepSeek Pro 和本地/免费能力，内网已有 Milvus、Embedding、Reranker、OCR 与 LLM 服务。两边协议、认证和模型标识可能不同。

## 决策

领域/应用层只依赖 LLM、Embedding、Reranker、OCR、VectorStore 端口。Adapter 根据配置中的 provider 名称装配，凭证只从环境或密钥系统注入。所有 Provider 必须返回稳定错误分类、耗时、模型/索引版本和可重试语义。

## 备选方案

- 全局直接调用某个 SDK：代码少，但测试、内外网切换和降级困难。
- 使用一个万能 HTTP 客户端：表面统一，却会丢失各能力的领域约束。

## 结果

替换内网实现主要是配置和 Adapter 工作。代价是需要维护契约测试，避免两个 Provider 对同一端口给出不同语义。
