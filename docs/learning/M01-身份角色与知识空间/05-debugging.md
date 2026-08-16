# M01 排障手册

## 401 AUTH_REQUIRED / AUTH_INVALID

先确认 `AUTH_MODE`，再按模式查：

- Mock：`GET /api/v1/auth/dev/presets` 是否存在；Header 值必须是 presetId。
- Header：服务看到的 `request.socket.remoteAddress` 是否落在 CIDR；不要用可伪造的 X-Forwarded-For 代替。
- JWT：检查 kid 是否能在 JWKS 找到、alg 是否在白名单、Issuer/Audience 是否精确一致、机器时钟和 exp。

日志只查 requestId 和稳定错误码，不要临时打印 Token。需要检查 JWT 内容时使用脱敏测试 Token，不把生产 Token 粘进工单。

## 403 ACCESS_DENIED

按顺序问：角色映射后是什么？空间里是否存在 USER/ROLE ACL？需要的是 READ/WRITE/REVIEW/ADMIN 哪一项？空间是否已停用？用 `/auth/me` 看服务端角色，不看浏览器自称角色。

## 授权后仍看不到 / 撤权后仍可见

检查 `authorization_state.version`、身份响应的 `authzVersion`、空间 `policy_version` 和 Redis generation。新请求应该拿到新 authzVersion。Redis 故障时 Adapter 会返回 cache miss 并回查 PG，不应该变成允许。

## 409 VERSION_CONFLICT

说明编辑页面使用了旧 `knowledge_spaces.version`。重新 GET 空间，展示差异后再次提交；不要由客户端盲目把 expectedVersion 加一。

## Request ID 对不上

M01 修复了一个中间件顺序问题：首个生成 requestId 的中间件必须写回 `request.headers`，让 Pino 和 AsyncLocalStorage 复用。若再次出现，比较响应头、错误体、审计和日志四处 ID。

## JWT 库与测试器兼容

实施中验证了 `jose` v6 ESM 与当前 Jest 29 CommonJS 沙箱不共享同一加载路径。最终选择 `jsonwebtoken 9 + jwks-rsa`，让生产和测试执行同一验签实现。工程决策应优先“安全行为能被真实测试”，而不是为了追新库堆私有加载桥。
