# 评测与生产可靠性：代码执行顺序详解

## 1. 创建评测集

1. `EvaluationController` 用 Zod 校验 Dataset 和 Case；RAG Case 必须有问题与空间，解析 Case 必须绑定事实或 fixture。
2. `EvaluationService` 只接受管理员/评测角色，Active Dataset 不允许原地修改。
3. `PostgresEvaluationRepository` 在事务中写 Dataset 和稳定 ordinal 的 Cases。

## 2. 创建和执行 Evaluation Run

1. 创建 Run 时冻结 Flow、Policy、Prompt、Embedding、Reranker、LLM、Validator、Manifest 与代码版本。
2. Case Result 先落为 `QUEUED`，离线 Worker 用 lease 与 `SKIP LOCKED` 领取，避免多副本重复执行。
3. Parser/Chunk Case 可读取绑定事实；问答案例走正常 Rag Run，再从检索、引用和校验表提取 `EvaluationActual`。
4. `scoreEvaluationCase` 逐 Case 计算十一项确定性指标和稳定 failure code。
5. `aggregateEvaluationMetrics` 计算样本数、均值和总体方差；没有样本的指标不会伪造为 0。
6. 完成后保存失败样本与指标，`compareEvaluationBaseline` 按指标方向识别退化。

## 3. PR 与发布门禁

1. `run-golden-regression.ts` 读取版本化选定集，复用生产评分器，任何 Case、阈值或 Baseline 退化都会非零退出。
2. Profile/Prompt/Flow/Manifest 变化创建完整 Evaluation Run。
3. `release-gate.ts` 读取真实 Run；状态未完成、指标不过线或相对 Baseline 退化都会阻止镜像发布。

## 4. 在线可靠性

1. `RedisTrafficControlAdapter` 用一段 Lua 原子检查多维速率与并发计数；Redis 不可用时默认拒绝新请求。
2. Run 完成或失败必须释放并发租约；TTL 是进程异常退出时的兜底，不是正常释放机制。
3. `executeResilientCall` 先计算剩余 Deadline，再设置单次 timeout，并把父级取消信号向下传播。
4. 仅 Timeout、429 和瞬态 5xx 按预算指数退避；Schema、鉴权、版本不匹配不重试。
5. Circuit Breaker 达到阈值后 OPEN，到期进入 HALF_OPEN；探测成功才 CLOSED。

## 5. 备份与恢复

1. `backup-restore.ts backup` 生成 PG custom dump、MinIO mirror 和显式指定的配置快照。
2. 对所有嵌套对象流式计算 SHA-256，Manifest 最后写入。
3. 恢复要求 `RESTORE_ACK`，先验证 Manifest、所有摘要、MinIO 凭据和配置目标，再覆盖数据。
4. PG/MinIO 恢复后运行 `rebuild-milvus.ts`，最后用固定授权问题验证答案和引用版本。
