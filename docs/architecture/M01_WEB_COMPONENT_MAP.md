# M01 Web Component Map：身份与知识空间

> 在写 `.vue` 文件前冻结组件边界，避免把 API、权限判断、表格和表单堆进一个页面。

## 设计方向

延续 M00 的“企业知识控制台”语言：深墨色导航、暖灰工作面、橙色操作强调。M01 使用一张连续的治理工作台，而不是大量悬浮卡片；空间列表是主视觉，右侧授权抽屉承担上下文操作。状态、权限和策略版本使用克制的标签与等宽数字表达。

## 页面与组件

```text
KnowledgeSpacesView（薄路由页）
└─ KnowledgeSpaceWorkbench（功能编排）
   ├─ SpaceToolbar（搜索 / 状态过滤 / 新建）
   ├─ SpaceTable（只展示，向上发出 select/edit/deactivate）
   ├─ SpaceEditorDialog（创建 / 基本信息更新）
   └─ SpaceAccessDrawer（当前空间治理上下文）
      ├─ GrantEditor（USER / ROLE 授权表单）
      ├─ GrantTable（ACL 列表与撤权事件）
      └─ PolicyTimeline（不可变策略版本）

SettingsView（薄路由页）
└─ DevelopmentIdentityPanel（仅 development + mock 模式渲染）
```

## 状态所有权与数据流

| 状态                | 唯一所有者                | 子组件输入        | 子组件输出          |
| ------------------- | ------------------------- | ----------------- | ------------------- |
| 空间列表、加载/错误 | `useKnowledgeSpaces`      | `items/loading`   | `refresh/select`    |
| 当前空间与 ACL/版本 | `useKnowledgeSpaces`      | `selectedSpace`   | `grant/revoke`      |
| 搜索和状态过滤      | `KnowledgeSpaceWorkbench` | `modelValue`      | `update:modelValue` |
| 创建/编辑表单草稿   | `SpaceEditorDialog`       | `mode/space/open` | `submit/close`      |
| Mock 身份选择       | `useDevelopmentIdentity`  | `presets/current` | `select`            |

## 权限展示原则

- 前端根据服务端返回的 `effectivePermissions` 隐藏或禁用按钮，只改善体验。
- 后端用例每次仍重新鉴权；前端状态绝不是授权依据。
- 身份请求 Header 只在开发 Mock 模式由统一 API Client 注入，业务组件不直接读写 Header。
- 生产构建收到非 Mock 运行时配置时，不渲染身份选择入口。

## 复用边界

- 页面只负责标题和装配，API 状态进入 composable。
- 表格、表单通过 props / emits 通信，不读取 Pinia 或路由。
- M01 暂不把页面内筛选提升到全局 Store；当前身份可在后续 M06 进入 Pinia。
