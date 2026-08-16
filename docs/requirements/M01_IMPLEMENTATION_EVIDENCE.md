# M01 身份、角色与知识空间：实施与验收证据

> 验收日期：2026-08-16  
> 目标：证明 M01 不是“接口能返回”的样例，而是一条覆盖身份建立、默认拒绝、空间 ACL、授权版本、缓存失效、审计和 Web 治理的可运行闭环。

## 1. 需求到实现映射

| 需求          | 核心实现                                                                                                                                        | 自动化/运行证据                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| AUTH-001      | `libs/contracts/src/internal/user-context.ts` 使用 opaque brand 隐藏可信上下文工厂；dependency-cruiser 禁止业务层深层导入                       | `pnpm boundary`                                                        |
| AUTH-002～005 | `libs/auth/src/*-auth.adapter.ts` 实现 mock、trusted-header、JWT/JWKS 三种 Adapter                                                              | `libs/auth/src/auth-adapters.spec.ts` 使用真实 RSA 签名覆盖 JWT        |
| AUTH-006      | `config/role-mapping.yaml` 与 `libs/auth/src/role-mapper.ts` 将内网角色映射为系统语义角色，未知角色映射为空                                     | Auth Adapter 单元测试                                                  |
| AUTH-007～008 | `database/migrations/20260816090000_m01_identity_and_knowledge_spaces.sql` 建立空间、ACL、策略快照、资源反查、全局授权版本和审计表              | 真实 PostgreSQL 集成测试                                               |
| AUTH-009～011 | `libs/application/src/knowledge-space.service.ts`、`apps/platform-api/src/m01/*`；Repository 每个方法显式接收 `AccessContext`；请求空间只做交集 | Application 单测与 M01 HTTP smoke test                                 |
| AUTH-012      | `libs/persistence-redis/src/redis-authorization-cache.adapter.ts` 使用 generation 主动失效；Key 包含 userId、角色 Hash、authzVersion、spaceId   | 真实 Redis 集成测试证明旧 generation 不再命中                          |
| AUTH-013      | `AuthorizationService.authorizeProtectedResource` 先反查资源所属空间，再按当前身份鉴权；资源类型覆盖文档、引用、历史消息、检索候选和导出        | `libs/application/src/authorization.service.spec.ts`                   |
| AUTH-014      | 全局 `AuthenticationGuard` 默认保护；`ApiExceptionFilter` 输出稳定错误码；public route 只能使用受控元数据显式声明                               | Mock 伪造角色 smoke test 返回 403，未知 preset 返回 401 `AUTH_INVALID` |
| AUTH-015      | `PostgresSecurityAuditAdapter` 记录管理/授权/拒绝事件并递归删除 token、secret、password、authorization、cookie、signature/header 字段           | 真实 PostgreSQL 审计脱敏集成测试                                       |

## 2. Web 验收

- `/settings` 只在非生产 Mock 模式显示服务端预置身份；浏览器只保存并发送 `presetId`，不发送 `userId` 或 `roles`。
- `/knowledge` 支持空间创建、搜索、状态筛选、修改、停用、USER/ROLE 授权、撤权和策略版本时间线。
- 管理按钮以服务端返回的 `effectivePermissions` 控制可见性；这只是体验优化，API 仍独立鉴权。
- 工具栏使用容器查询适配导航栏和权限抽屉挤压；926px 与 1440px 视口均完成浏览器视觉检查。
- 浏览器真实创建 `m01-learning`，为 `KNOWLEDGE_READER` 写入 READ 授权，策略版本从 v1 变为 v2；切换为 `knowledge-reader` 后仅能读取且所有管理按钮消失。

`WEB-008` 仍保持未完成：M01 已交付基本信息、用户/角色授权和授权策略版本；质量策略将在 M04、检索 Profile 将在 M05/M07 接入，不能提前把整条跨模块需求标记为完成。

## 3. 可重复验收命令

```powershell
pnpm db:migrate
pnpm test:integration
pnpm test
pnpm check
pnpm security:audit
```

当只启动 M01 所需的 PostgreSQL 与缓存 Redis、尚未启动 MinIO/Milvus 时，可精确执行：

```powershell
pnpm db:migrate
pnpm exec cross-env RUN_INTEGRATION_TESTS=true jest --runInBand --config test/jest-integration.config.cjs test/integration/m01-authorization.integration.spec.ts
```

2026-08-16 实测结果：M01 集成测试 3/3 通过；生产依赖审计为 `No known vulnerabilities found`。完整 `pnpm test:integration` 还会执行 M00 五件基础设施健康测试，需先用 `pnpm dev:infra` 启动 PostgreSQL、两类 Redis、MinIO 和 Milvus。

本地交互验收：

```powershell
pnpm dev:platform-api
pnpm dev:web
```

打开 `http://localhost:5173/settings` 切换身份，再进入 `http://localhost:5173/knowledge`。开发预置身份来自服务端配置；不要在浏览器开发工具中伪造角色 Header，因为服务端不会信任它。

## 4. 安全不变量

1. 只有认证 Adapter 能建立可信 `UserContext`。
2. 未认证、未知角色、未知资源映射和基础设施异常全部默认拒绝。
3. 客户端只能缩小查询空间，不能扩大服务端授权集合。
4. 所有资源访问都回到知识空间重新鉴权，避免仅按资源 ID 读取形成 IDOR。
5. 授权变化在同一数据库事务中写 ACL、递增版本、保存策略快照；事务成功后失效缓存。
6. 前端隐藏按钮不是安全边界，Controller/Application/Repository 三层仍保留校验或约束。
