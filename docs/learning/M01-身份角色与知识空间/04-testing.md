# M01 测试策略

## 为什么安全规则要分层测

- Contract：未知角色、非法 ACL 主体和输入格式是否在边界被拒绝。
- Domain：权限蕴含和 requestedSpaceIds 交集是否纯粹正确。
- Adapter contract：Mock/Header/JWT 是否得到同一 UserContext 语义。
- Application：默认拒绝、审计、缓存 Key、资源重鉴权是否正确。
- HTTP smoke：伪造 Header 经过真实 Guard 后仍返回稳定 401/403。
- PostgreSQL integration：事务、策略快照、撤权和全局版本是否在真实 SQL 上闭环。
- Vue：客户端只发送 presetId；READ/ADMIN 的操作可见性矩阵。

## 关键攻击用例

| 攻击/故障                           | 预期                                  |
| ----------------------------------- | ------------------------------------- |
| Mock 请求附加 `SYSTEM_ADMIN` Header | 被忽略，只用服务端 preset             |
| 重复认证 Header                     | 401 AUTH_INVALID                      |
| Header 来自非受信 socket 地址       | 401 AUTH_SOURCE_UNTRUSTED             |
| HMAC 时间戳过期/签名错误            | 401，不回显签名细节                   |
| JWT Audience 错误                   | 401 AUTH_INVALID                      |
| 未知内网角色                        | 身份可建立但 roles 为空，资源默认拒绝 |
| requestedSpaceIds 含无权空间        | 返回交集，不报“额外空间存在”          |
| 撤权后旧缓存                        | 代次和 authzVersion 共同隔离          |
| 删除最后 ADMIN                      | 事务回滚                              |
| 引用/历史/候选/导出侧路             | 反查 space 并执行当前权限             |

## 命令

```powershell
pnpm test:contract
pnpm exec jest --runInBand libs/auth libs/domain libs/application
pnpm exec jest --runInBand apps/platform-api/src/m01
pnpm --filter @rag/web-console test

# 需要 PostgreSQL/Redis 容器
pnpm test:integration
```

不要只断言 HTTP 状态码；同时断言稳定 code、Repository 未被调用、审计被调用和敏感值未写入。
