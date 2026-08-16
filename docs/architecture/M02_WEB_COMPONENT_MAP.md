# M02 Web 组件边界图

> 本图在编写 Vue 组件前冻结，用于约束路由页、业务组件、Composable 与 API Adapter 的职责。

```mermaid
flowchart TD
  A["DocumentIngestionView 路由页"] --> B["UploadWorkbench 上传编排"]
  A --> C["JobCenter 任务中心"]
  B --> D["UploadDropzone 文件选择"]
  B --> E["UploadQueue 上传队列"]
  E --> F["UploadQueueItem 单文件/分片状态"]
  B --> G["useDocumentUpload 会话、取消、重试"]
  C --> H["JobFilters 过滤"]
  C --> I["JobTable 任务列表"]
  C --> J["JobDetailDrawer 任务与步骤"]
  C --> K["useIngestionJobs ETag 轮询与恢复"]
  G --> L["documentIngestionApi 契约校验"]
  K --> L
  L --> M["Platform API /api/v1"]
  E -. "浏览器 PUT，文件字节不经过 API" .-> N["MinIO 预签名 URL"]
```

## 状态所有权

- `DocumentIngestionView`：只负责页面布局和空间选择，不保存上传细节。
- `useDocumentUpload`：保存上传会话、XHR、分片重试次数和本机恢复快照。
- `useIngestionJobs`：保存查询条件、列表、当前详情与后端事件游标。
- `UploadQueueItem`：通过 props 接收文件状态，通过 emits 发出取消/重试意图，不直接请求 API。
- `JobDetailDrawer`：只呈现后端返回的 `stagePercent/overallPercent`；值为 `null` 时使用不确定进度。
- `documentIngestionApi`：统一注入认证信息，并用 Zod 校验所有响应。

## 刷新恢复边界

浏览器只在 `localStorage` 保存 `uploadSessionId/fileId/fileName/size` 等非敏感定位信息。页面刷新后向后端重新查询会话或任务；预签名 URL 不落盘，过期后重新申请。已经交给 MinIO 的字节进度无法从浏览器精确恢复，因此显示“等待续传”，而不是构造百分比。
