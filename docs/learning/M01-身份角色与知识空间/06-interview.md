# M01 面试追问与回答骨架

## 1. 单企业为什么还需要 ACL？

单企业只消除了 tenantId 隔离，不代表 HR、法务、财务知识互相公开。角色到空间 ACL 仍是最小权限边界。

## 2. 为什么业务代码不能直接读 Header？

Header 是传输细节且默认可伪造。集中到 AuthPort 后，来源校验、验签、映射和错误策略只有一份，内网协议变化不影响用例。

## 3. Trusted Header 最大风险是什么？

客户端绕过网关直连服务，或网关没有删除同名外部 Header。解决：网络策略限制源 CIDR、服务检查直接 socket 地址、网关重写 Header、可选 timestamp + HMAC、防重复 Header 歧义。

## 4. JWT 只 decode 为什么不行？

decode 只解析 Base64，不证明签发者。必须验签，并固定 alg、Issuer、Audience、exp；JWKS 还要处理 kid 和密钥轮换。

## 5. 为什么未知角色不是认证失败？

身份可能真实，只是没有系统权限。映射为空后资源默认拒绝，既 fail-closed，又避免 IdP 新增无关角色导致所有请求 401。企业也可以按策略改成严格失败。

## 6. 角色为什么不自动访问所有空间？

语义角色是 ACL 主体，不是全局通行证。这样错误映射的爆炸半径限制在明确授权空间。只有 SYSTEM_ADMIN 是显式全局例外。

## 7. WRITE 和 REVIEW 为什么分开？

内容维护与发布审核需要职责分离。WRITE 蕴含 READ；REVIEW 蕴含 READ；二者互不蕴含，ADMIN 才包含全部。

## 8. requestedSpaceIds 怎么防越权？

先从服务端 Repository 得到 allowedSpaceIds，再与客户端集合取交集。绝不能把客户端集合直接拼进“允许列表”。

## 9. 为什么 Repository 还要接 AccessContext？

应用层鉴权是主规则，SQL 再使用上下文是纵深防御，也防止未来后台任务绕开 Controller 直接调用 Repository 时丢失主体。

## 10. 撤权缓存怎么保证？

ACL 事务递增全局 authzVersion；应用提交后递增 Redis generation；Key 含 userId、rolesHash、authzVersion、spaceId；TTL 是最后兜底。Redis 故障返回 miss 回查 PG。

## 11. 为什么全局版本，不按用户版本？

中型规模不超过 200 空间，全局失效简单可靠。代价是一次 ACL 变化让所有用户缓存换代。规模扩大后可以拆成 user/role/space version，但复杂度更高。

## 12. 策略版本和乐观锁版本区别？

乐观锁 version 防止基本信息并发覆盖；policyVersion 是 ACL 不可变历史，用来审计和给任务/Run 锁定配置。

## 13. 如何避免撤销最后一个管理员？

授权修改对空间 `FOR UPDATE`，变更后在同一事务检查至少一条包含 ADMIN 的 ACL；失败则整体回滚。SYSTEM_ADMIN 仍可恢复治理。

## 14. 为什么引用还要重鉴权？

答案或历史中保存的是旧时刻引用。用户可能已经被撤权；若只信旧 Run，引用预览会成为侧信道。每次按资源反查 space 再查当前 ACL。

## 15. 审计为什么不能记录 Token？

Token 是可复用凭证，进入长期保留审计表会扩大泄漏面。审计只需身份快照、动作、资源、结果、版本、原因和 requestId。
