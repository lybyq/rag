# M00 Web Console 组件图

> 先设计组件职责再实现页面，防止视图层承担 API、状态机和展示的全部责任。

## 页面与组件边界

```text
App.vue
└─ AppShell.vue                         # 全局布局、导航和用户区域
   └─ RouterView
      ├─ FoundationOverviewView.vue     # M00 工程基线总览（薄页面）
      │  ├─ PageHeader.vue              # 标题、环境徽标、主操作
      │  ├─ SystemPulse.vue             # 四进程和基础设施状态
      │  ├─ DeliveryRoadmap.vue         # M00～M10 实施路径
      │  └─ ArchitectureNotes.vue       # 当前架构决策摘要
      └─ PlaceholderView.vue            # 尚未实施模块的明确占位页
```

## 数据流约束

- `FoundationOverviewView` 只负责组合组件，不直接发请求。
- `useServiceHealth` 负责健康接口访问、超时、刷新和错误归一化；视图只读取状态并触发 `refresh`。
- 展示组件使用 `props down / emits up`，不得修改传入对象。
- Pinia 留给跨页面身份、知识空间和全局通知；M00 的页面内健康状态不需要提前全局化。
- Element Plus 通过自动导入使用；Element Plus X 后续只从 `features/assistant/adapters` 适配，不让业务代码绑定第三方事件结构。

## 后续模块落点

| 需求               | Feature 目录                | 主要状态                           |
| ------------------ | --------------------------- | ---------------------------------- |
| 文档上传与解析进度 | `features/ingestion`        | upload、job、stage、progress       |
| 知识空间与权限     | `features/knowledge-spaces` | currentSpace、roles、policy        |
| 问答与证据         | `features/assistant`        | conversation、run、event、evidence |
| 评测与运维         | `features/operations`       | evaluation、SLO、alert、recovery   |
