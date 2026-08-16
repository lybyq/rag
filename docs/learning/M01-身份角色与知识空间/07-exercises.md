# M01 练习

## 练习 1：亲手验证不可扩权

切到 `knowledge-reader`，用 curl 同时附加 `X-Authenticated-Roles: SYSTEM_ADMIN` 创建空间。记录 HTTP code、稳定错误码、Repository 是否执行，并解释为什么 Mock Adapter 忽略该 Header。

## 练习 2：扩展一个企业角色映射

在 `config/role-mapping.yaml` 添加 `corp_rag_maintainer: [KNOWLEDGE_EDITOR]`，把一个 Mock preset 改成该原始角色。先写失败测试，再修改配置，解释为什么代码不应知道 `corp_*`。

## 练习 3：画出 JWT 验证清单

不看代码写出签名、kid/JWKS、alg、Issuer、Audience、exp、user claim、roles claim 八步。分别说漏掉每一步的攻击面。

## 练习 4：证明 requestedSpaceIds 只能缩小

设计 allowed 为 A/B、requested 分别为 undefined、空数组、B/C、重复 B。写出预期并运行领域测试。

## 练习 5：制造乐观锁冲突

读取同一空间两次，用相同 expectedVersion 连续更新。第二次应返回 409。说明为什么客户端不能静默重试覆盖。

## 练习 6：观察撤权版本

授权前后查询 `authorization_state`、`knowledge_spaces.policy_version`、策略历史和 `/auth/me`。画出旧请求与新请求的缓存 Key 差异。

## 练习 7：补一个侧路资源

向 `protected_resource_spaces` 写入一条 CITATION 映射，分别用有权和无权用户调用 `requireResourcePermission`。解释为什么不能只在搜索候选阶段过滤一次。

## 练习 8：故障演练

停止 Redis 后访问一个空间：请求应回查 PostgreSQL而不是放行或完全不可用。再停止 PostgreSQL：认证版本无法确认，应 fail-closed。记录每次状态码、日志和审计行为。

每个练习保存：前置状态、命令、预期、实际、代码位置、一个反例。能够白板讲清“认证 → 角色映射 → ACL → 缓存版本 → 审计”后再进入 M02。
