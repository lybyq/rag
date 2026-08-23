# 备份恢复与 Milvus 重建手册

## 目标与当前状态

企业 RPO/RTO 在内网上线评审前确认，当前为 `RPO=TBD`、`RTO=TBD`。本手册提供可执行闭环，但没有真实隔离恢复报告前不得把 OPS-014 标记完成。

事实源：PostgreSQL、MinIO 和显式指定的版本化配置。Milvus 是派生索引，恢复后重建。备份根目录默认 `D:\rag-backups`，不得写 C 盘。

## 备份

```powershell
$env:DATABASE_URL='postgresql://rag:***@127.0.0.1:5432/rag'
$env:MINIO_ENDPOINT='http://127.0.0.1:9000'
$env:MINIO_ACCESS_KEY='***'
$env:MINIO_SECRET_KEY='***'
$env:RAG_CONFIG_FILE='D:\rag-config\profiles.yaml'
$env:RAG_BACKUP_ROOT='D:\rag-backups'
pnpm backup
```

脚本输出 PG custom dump、MinIO 嵌套对象、配置快照和 `manifest.json`。Manifest 包含逐文件 SHA-256；备份目录必须位于加密卷并限制访问。完成后复制到独立故障域并再次验证摘要。

## 隔离恢复演练

1. 新建隔离 PostgreSQL/MinIO/Milvus，不得指向生产。
2. 记录演练开始时间和备份 `createdAt`，用于计算实际数据点和恢复时间。
3. 设置显式确认后恢复：

```powershell
$backupId='2026-08-23T08-00-00.000Z'
$env:RESTORE_ACK="restore:$backupId"
$env:RAG_RESTORE_CONFIG_TARGET='D:\rag-restore\profiles.yaml'
pnpm restore -- $backupId
pnpm milvus:rebuild
```

脚本在覆盖前验证 Manifest、所有摘要、MinIO 凭据和配置目标。任何校验失败都必须停止，不能跳过。

## 恢复后验收

1. `pnpm db:migrate` 确认 Schema 版本。
2. 对账空间、文档、版本、Chunk、active Manifest、对象数和审计数。
3. 重建 Milvus，核对 dimension、metric、revision、向量数和 Manifest 成员数。
4. 使用固定的 ALLOW、DENY、拒答、版本和引用问题执行真实 Run。
5. 打开引用确认当前权限与不可变版本；运行 `pnpm evaluation:golden` 和完整 Evaluation Baseline。
6. 记录实际 RPO、PG/MinIO 恢复耗时、索引重建耗时、总 RTO 和未恢复项。

## 演练报告模板

```text
演练编号：
环境/机器规格：
应用提交、Flow、Profile、Manifest：
备份 ID / createdAt：
故障假设：
目标 RPO/RTO：TBD / TBD
实际数据点、实际 RPO：
PG、MinIO、配置恢复耗时：
Milvus 重建耗时：
固定查询和权限结果：
总 RTO：
问题、负责人和截止时间：
审核人：
```
