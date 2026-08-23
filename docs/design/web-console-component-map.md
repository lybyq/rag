<!--
  Web 产品与全链路验收的组件边界图。
  本文先于实现固定 Route View、feature、composable 与第三方组件 Adapter 的职责，
  避免页面在快速交付中退化成难测试、难替换的巨型单文件组件。
-->

# Web Console 组件边界图

> 关联需求：`WEB-001`～`WEB-030`

## 设计方向

界面采用“企业知识控制室”风格：深墨色导航、纸张色工作区、橙色操作强调，信息密度适中；不使用通用聊天产品的紫色渐变和模板化卡片。桌面端优先，在 900px 以下切换为抽屉导航和单列内容。

## 组件与数据边界

```text
AppShell.vue                         只负责全局导航、身份摘要和 RouterView
├─ OverviewView.vue                 只组合 OverviewWorkbench
│  └─ features/overview
│     ├─ OverviewWorkbench.vue      总览区块编排
│     ├─ MetricStrip.vue            业务指标展示；props in
│     ├─ QualityTrend.vue           质量趋势；props in
│     └─ useOverview.ts             汇总 API、加载/失败/重试
├─ KnowledgeSpacesView.vue          只组合 KnowledgeSpaceWorkbench
│  └─ features/knowledge-spaces     空间、授权、策略和版本事实
├─ DocumentIngestionView.vue        只组合 DocumentIngestionWorkbench
│  └─ features/document-ingestion   上传、任务 SSE、文档详情和审核
├─ AssistantView.vue                只组合 RagChatWorkbench
│  └─ features/chat
│     ├─ RagChatWorkbench.vue        会话、消息与引用抽屉编排
│     ├─ ConversationSidebar.vue     会话选择；emits select/create
│     ├─ RagMessageList.vue          消息列表；emits citation/feedback
│     ├─ RagAnswerMessage.vue        最终答案、Claim 引用和状态
│     ├─ RagRunStage.vue             公开阶段；不接收思维链字段
│     ├─ RagSender.vue               问题输入；emits submit/cancel
│     ├─ CitationDrawer.vue          每次打开重新请求引用预览
│     ├─ useRagRun.ts                Run 创建、SSE、轮询、刷新恢复
│     └─ useSseReconnect.ts          Last-Event-ID 和退避重连
├─ EvaluationView.vue               只组合 EvaluationWorkbench
│  └─ features/evaluation            数据集、运行、基线和失败样本
├─ OperationsView.vue               只组合 OperationsWorkbench
│  └─ features/operations            服务、队列、告警和授权动作
├─ AuditView.vue                    只组合 AuditWorkbench
│  └─ features/audit                 过滤、游标分页和脱敏导出
└─ SettingsView.vue                 只组合 ProviderProfileWorkbench
   └─ features/settings              Provider/Profile 元数据和健康

components/ai-adapter
├─ AiConversationList.vue           包装 Conversations
├─ AiBubbleList.vue                 包装 BubbleList
├─ AiSender.vue                     包装 XSender
├─ AiThinking.vue                   包装 Thinking
└─ element-plus-x.types.ts          项目稳定契约；业务不得导入上游类型
```

## 状态规则

每个 feature 必须显式区分 `idle/loading/ready/empty/error/forbidden/cancelled`；列表排序和分页来自后端，上传百分比来自 XHR 字节事实，入库和问答阶段来自服务端 SSE/轮询事件。组件只能通过 typed props/emits 交互，不直接修改父组件状态。
