# M04 管理端组件地图

## 视觉方向

延续任务中心的“编辑部质检台”风格：暖灰纸张底色、深色审计带、琥珀人工复核和红色硬拒绝标记。信息密度服务审核，不使用无意义渐变或装饰卡片。

## 组件职责

| 组件                     | 单一职责                                     | Props                                          | Emits                     |
| ------------------------ | -------------------------------------------- | ---------------------------------------------- | ------------------------- |
| `KnowledgeQualityPanel`  | 组合运行选择、质量摘要、Chunk 表和审核弹窗   | `documentVersionId`                            | 无                        |
| `QualityReportSummary`   | 展示自动结论、审核状态、指标和发现项         | `run`、`report`、`findings`                    | `review`                  |
| `KnowledgeChunkTable`    | 分页展示 Parent/Child、Token、定位和展示文本 | `chunks`、`loadingMore`、`hasMore`             | `loadMore`                |
| `QualityReviewDialog`    | 收集审核动作、原因并显示提交失败             | `open`、`report`、`submitting`、`errorMessage` | `update:open`、`submit`   |
| `useKnowledgeProcessing` | 维护加载、竞态取消、游标、审核提交和错误状态 | `MaybeRefOrGetter<versionId>`                  | 返回只读状态和显式 action |

## 状态覆盖

- 首次加载：Skeleton。
- 空数据：提示 M04 尚未运行。
- 请求失败：稳定公开消息与重试按钮。
- 403：明确显示无权查看/审核，不伪装为空数据。
- Chunk 空页：独立 Empty。
- 游标分页：真实 API 游标，不在前端猜总量。
- 审核提交：按钮 loading；Dialog 可取消，取消不会产生服务端副作用。
- 乐观锁冲突：保留原因输入，显示冲突并允许关闭后重新加载。

## 数据流

```text
JobDetailDrawer
  └─ KnowledgeQualityPanel(documentVersionId)
       ├─ useKnowledgeProcessing → Platform API + Zod
       ├─ QualityReportSummary → review event
       ├─ KnowledgeChunkTable → loadMore event
       └─ QualityReviewDialog → submit event → composable.review()
```
