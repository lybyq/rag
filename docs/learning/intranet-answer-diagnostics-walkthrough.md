# 从一次问答的阶段记录定位问题

关联 OPT-001。这里解释当前首批诊断实现，不代表整个优化计划已完成。

## 执行顺序

1. AnswerGenerationExecutionService 启动 Run，把 lifecycleAudit 交给答案图。Run 已有模型、流程、Manifest 等快照，先用它确认当时运行版本，不拿今天的配置猜昨天的请求。
2. timedNode 开始时调用 startStep，保存阶段与尝试编号。模型调用仍在原节点执行，诊断不改变回答策略。
3. 节点返回时只提取数量、状态、耗时等摘要。答案上下文的 includedSourceIds 和 omittedSourceIds 分别表示真正送入模型和被预算/配额省略的来源。
4. 证据扩展材料已经过 Repository 权限/版本检查，所以这里才能按 documentId 计算可访问文档数。搜索引擎原始命中数不可直接显示给用户。
5. 模型故障先经 answerDiagnosticErrorCode 白名单分类，再写 outputSummary 和步骤顶层 errorCode。不能直接保存 error.message，也不能假定 error.code 天然安全。
6. lifecycle.finishStep 把摘要存到现有 rag_run_steps.output_summary，沿用既有步骤查询接口，无新增数据库表或迁移。是否向普通用户实时投递这些数量，还要等待时间线阶段的授权/重连门禁。

## 大白话排障

有候选、无扩展材料：检查权限、版本、发布时间或回源复核。材料不为空、上下文省略很多：检查预算及每文档配额。生成节点 TIMEOUT：是模型调用等待问题，不能说成知识库无答案。生成成功、最终 REJECT：继续看校验报告中的引用、数值、语义或覆盖问题。

durationMs 是节点内经过的时间，不能当纯 GPU 推理时间；generate_draft 的 generationAttempt 表示第几份草稿，不能当底层 HTTP 重试次数。这两种统计后续会进一步分开。

## 为什么这样设计

面试被问“为什么检索对了还答错”，先解释候选、复核证据、实际上下文、草稿、最终答案是不同产物。每层都可能移除或改变信息，因此需要层间可核对的计数和原因，而不是只记录一次总耗时。

测试里的模型和数据库端口是模拟的，用于稳定复现控制流；真实内网模型速度、召回质量和权限 SQL 仍必须通过对应环境测试。
