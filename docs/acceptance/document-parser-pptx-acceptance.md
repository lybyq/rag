# PPTX 页序、结构与能力边界验收记录

> 日期：2026-09-06；需求：PAR-020；测试文件均由合成 OOXML 在内存生成。

## 已验收语义

- `slideNo` 取 `presentation.xml/p:sldIdLst` 的位置，并通过 `ppt/_rels/presentation.xml.rels` 找到真实 Slide；文件名只在旧文档完全没有页序清单时回退并产生 `PPTX_PRESENTATION_ORDER_FALLBACK`。
- 同一 `a:p` 内多个 `a:r/a:t` 直接拼接；只有段落边界和显式 `a:br` 产生换行，避免把一句话拆成多个检索噪声行。
- Slide 占位符没有 `type` 时按 `idx` 依次查询 Slide Layout 和 Slide Master；Block 记录 `placeholderTypeSource`，标题层级来源可审计。
- 组合图形根据 `off/ext/chOff/chExt` 递归换算子图形坐标；旋转/翻转只能输出轴对齐近似 bbox 时产生 `PPTX_ROTATED_COORDINATE_APPROXIMATED`。
- 表格从 `a:tc` 读取 `rowSpan/gridSpan/hMerge/vMerge`，同一单元格内的 Run 不换行；输出矩阵扩展到合并终点，continuation 不重复正文。
- 页统计包含原生表格文字和图片替代文本，图片关系映射到真实 `ppt/media` 归档条目及当前 `slideNo`。
- 备注、图表、SmartArt、隐藏页、孤立合并 continuation、无法解析的图片尺寸和无法关联的图片资产均有稳定告警，不静默宣称完整解析。

## 自动化证据

```text
pptx.parser.spec.ts：5 tests passed
PPTX + 九格式 Golden/security：26 tests passed，5 snapshots passed
TypeScript strict、targeted ESLint/Prettier：passed
```

## 支持边界

- 隐藏页正文当前仍被抽取，但所有 Block 带 `metadata.hidden=true`；业务可在知识加工审核策略中决定发布或排除，Parser 不替业务做不可逆删除。
- 图表和 SmartArt 目前只报告存在而不提取数据标签/底层工作簿；若企业样本要求检索这些内容，应新增专用 OOXML Adapter、Golden 和 parser revision。
- 备注页当前不进入正文，因为演讲者备注可能含内部提示或敏感信息；开放前必须先确定权限与发布策略。
- 任意旋转后的 bbox 是覆盖内容的轴对齐近似框，不等价于多边形。需要像素级引用时应使用可离线部署的渲染 Adapter 并升级契约。
