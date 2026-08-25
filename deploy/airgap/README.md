# Enterprise RAG 无网络部署包使用说明

本目录的发布版不包含 `build:`，内网启动不会访问 Docker Hub、npm 或其他公网。请先阅读随包 `docs/08-内网离线部署.md` 和 `docs/provider-http-contracts.md`。

## 最短启动路径

Windows：

```powershell
.\load-images.ps1
Copy-Item runtime.env.example runtime.env
# 填写 runtime.env，不能保留“必须替换”
.\preflight.ps1
.\start.ps1                  # 使用公司已有 Milvus
# .\start.ps1 -BundledMilvus # 使用随包单机 Milvus
.\status.ps1
```

Linux：

```bash
bash load-images.sh
cp runtime.env.example runtime.env
# 填写 runtime.env
bash preflight.sh
bash start.sh
# BUNDLED_MILVUS=true bash start.sh
bash status.sh
```

停止不会删除数据。不要运行 `docker compose down --volumes`，不要直接删除 `data/`。

## 上线前必须确认

- 认证网关会删除用户伪造 Header 并注入可信 userId/roles；API 容器不可直连。
- MinIO Endpoint 同时能被 Docker 容器和用户浏览器解析。
- LLM/Embedding/Reranker/OCR 完成契约测试和真实脱敏 Golden。
- 配置内网 Embedding 后全量重建 Manifest，不能沿用 Fixture 向量。
- 完成漏洞扫描、签名、长稳、Chaos、备份恢复和业务 RPO/RTO。
