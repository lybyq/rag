# M01 概念：先分清认证、授权和治理

## 1. 认证不是授权

认证（Authentication）回答“请求者是谁”，输出服务端可信的 `UserContext`：

```ts
interface UserContext {
  userId: string;
  roles: SemanticRole[];
  authzVersion: number;
  resolvedAt: string;
}
```

授权（Authorization）回答“这个身份能否对这个具体资源执行某个动作”。即使用户有 `KNOWLEDGE_EDITOR`，也不能自动编辑所有空间；它必须匹配空间 ACL。把这两步混在一个 Header 判断里，会让信任边界散落到每个 Controller。

## 2. 为什么不能相信浏览器提交的 roles

浏览器、移动端和 curl 都处在不可信边界。攻击者可以添加 `X-Authenticated-Roles: SYSTEM_ADMIN`、修改 JSON，甚至重复发送同名 Header 诱导网关与应用产生不同解析。M01 规定只有 Auth Adapter 能构造带品牌的 `UserContext`：

- Mock：浏览器只选择服务端预置 `presetId`。
- Trusted Header：校验直接连接源 CIDR；可再校验 timestamp + HMAC。
- JWT：验签并检查 Issuer、Audience、exp 和算法白名单。

三种传输最终得到相同的 `UserContext`，所以业务用例不需要知道内网最后选择哪种协议。

## 3. 原始角色与系统语义角色

企业 IdP 可能把角色叫 `rag_maintainer_cn`，代码不能散落这种企业专有名称。`config/role-mapping.yaml` 显式映射为六种语义角色。未出现在映射文件中的角色返回空集合，而不是猜测最相近权限。这叫 fail-closed。

## 4. ACL 主体和权限蕴含

一条 ACL 由主体和权限组成：

- 主体：`USER/alice` 或 `ROLE/KNOWLEDGE_READER`。
- 权限：READ、WRITE、REVIEW、ADMIN。

WRITE 蕴含 READ；REVIEW 蕴含 READ，但 WRITE 与 REVIEW 互不蕴含；ADMIN 蕴含全部。这样审核人可以读并审核，但不必能修改原文。

`SYSTEM_ADMIN` 是唯一全局越过空间 ACL 的 break-glass 语义角色。其他角色都必须匹配空间 ACL，避免一次错误角色映射泄漏全部知识。

## 5. 乐观锁、策略版本和授权版本

三个版本解决不同问题：

- `knowledge_spaces.version`：基本信息乐观锁，防止两位管理员互相覆盖。
- `policyVersion`：该空间 ACL 的不可变历史版本，回答“当时为什么能访问”。
- `authzVersion`：全局授权代次，进入身份快照和缓存 Key；任意 ACL 改变后递增。

撤权时只删 Redis Key 不够：多实例、网络故障和并发请求都会留下旧值。M01 同时使用“主动递增缓存代次 + 新 authzVersion 换 Key + 60 秒 TTL”三道防线。

## 6. 审计日志和普通日志不同

普通日志服务排障，可能采样和滚动；审计日志证明“谁在何时对什么做了什么，结果如何”。审计事件保存 actor、roles 快照、authzVersion、动作、资源、结果、原因、requestId，但永远不保存 Token、Cookie、Header 签名或密钥。
