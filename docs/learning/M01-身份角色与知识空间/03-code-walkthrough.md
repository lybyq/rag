# M01 代码走读顺序

建议按下面顺序打开文件，不要从 Controller 逆向猜业务。

## 1. 运行时契约

先看 `libs/contracts/src/auth.ts` 和 `knowledge-space.ts`。注意 TypeScript 类型会消失，所以 HTTP 输入必须由 Zod 拒绝未知角色、非法 code、空权限和缺失乐观锁版本。

`internal/user-context.ts` 使用模块私有 `unique symbol` 给身份加品牌；公共 barrel 只导出类型，不导出构造函数。dependency-cruiser 再限制内部工厂只能被 Auth/Testing Adapter 直接引用。

## 2. 纯领域规则

看 `libs/domain/src/authorization.ts`：

1. `expandPermissions` 固定权限蕴含和输出顺序。
2. `matchesAclSubject` 区分 USER 与 ROLE。
3. `restrictRequestedSpaceIds` 只做集合交集。

这里没有 Nest、pg、Redis，面试时可以解释：稳定业务不变量不应该依赖基础设施。

## 3. 三种认证 Adapter

按 Mock → Header → JWT 阅读：

- Mock 不读取请求中的 roles，只用 presetId 查服务端预置。
- Header 读取 socket 的直接地址，不信任 `X-Forwarded-For`；重复 Header 直接拒绝。
- JWT 使用 `jsonwebtoken` 验签、`jwks-rsa` 处理公钥轮换；算法必须在非对称白名单内，并额外要求 exp/iss/aud 存在。

三者最后都调用 `createAuthenticatedContext` 做 userId 清洗、角色映射、authzVersion 绑定和冻结。

## 4. 应用用例

`AuthorizationService` 是所有资源授权的统一入口。看它如何生成 roles SHA-256 缓存 Key、记录 DENIED 审计，以及如何把 requestedSpaceIds 与数据库可见集合取交集。

`KnowledgeSpaceService` 编排用例顺序。例如授权：先要求 ADMIN → Repository 事务写入 → 主动失效缓存 → 写 SUCCESS 审计。Controller 没有复制这套规则。

## 5. PostgreSQL Adapter

`PostgresKnowledgeSpaceRepository` 的每个方法第一个参数都是 `AccessContext`。写 SQL 再次把 userId/roles 放进权限条件，属于纵深防御。重点阅读：

- `create`：空间、owner ADMIN ACL、v1 策略快照、全局版本在一个事务。
- `upsertGrant/revokeGrant`：`FOR UPDATE` 串行化同空间策略修改。
- `ensureAtLeastOneAdmin`：避免把空间锁死。
- `resolvePermissions`：仅合并当前 USER/ROLE ACL，再应用领域蕴含。

## 6. HTTP 与 Vue

`AuthenticationGuard` 全局默认保护路由，只有带 `PUBLIC_ROUTE_METADATA` 的健康、指标、开发预置接口跳过。Controller 把可信身份和 RequestContext 组合成显式 AccessContext。

Vue 从 `platformApi.ts` 开始：统一注入 presetId 和解析 ApiError。`useKnowledgeSpaces` 拥有远端状态，组件只收 props/发 events。`effectivePermissions` 隐藏按钮只是 UX，后端仍重鉴权。
