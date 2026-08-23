/**
 * 评测用例与异步执行的应用层端口。
 *
 * Application 只编排版本、租约、评分和基线；PostgreSQL 查询、可信身份恢复与 RagRun 创建
 * 由 Adapter 完成。这样评测不会绕过正常问答权限，也不会把数据库实现泄漏给评分器。
 *
 * @requirement OPS-001
 * @requirement OPS-003
 * @requirement OPS-004
 */
import type {
  CreateEvaluationCaseRequest,
  EvaluationActual,
  EvaluationBaseline,
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationDataset,
  EvaluationMetric,
  EvaluationRun,
  EvaluationRunDetail,
  EvaluationSnapshot,
  SemanticRole,
} from '@rag/contracts';
import type { AccessContext } from './ports';

/** 数据集创建命令包含可信创建人身份快照。 */
export interface CreateEvaluationDatasetCommand {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly cases: readonly CreateEvaluationCaseRequest[];
  readonly createdBy: string;
  readonly creatorRoles: readonly SemanticRole[];
  readonly creatorAuthzVersion: number;
}

/** 新建评测运行命令。 */
export interface CreateEvaluationRunCommand {
  readonly datasetId: string;
  readonly baselineId?: string;
  readonly note?: string;
  readonly snapshot: EvaluationSnapshot;
  readonly createdBy: string;
  readonly creatorRoles: readonly SemanticRole[];
  readonly creatorAuthzVersion: number;
}

/** Worker 租约领取的一条 Case；问题正文仅在受控后台链路使用。 */
export interface ClaimedEvaluationCase {
  readonly resultId: string;
  readonly evaluationRunId: string;
  readonly testCase: EvaluationCase;
  readonly fixtureActual?: EvaluationActual;
  readonly ragRunId: string | null;
  readonly ownerUserId: string;
  readonly ownerRoles: readonly SemanticRole[];
  readonly ownerAuthzVersion: number;
  readonly ownerRolesSha256: string;
  readonly attempts: number;
}

/** 已完成运行等待聚合的内部形状。 */
export interface ReadyEvaluationRun {
  readonly run: EvaluationRun;
  readonly scores: readonly {
    readonly resultId: string;
    readonly passed: boolean;
    readonly scores: Readonly<Record<string, number>>;
  }[];
  readonly baseline: EvaluationBaseline | null;
}

/** 评测 PostgreSQL 事实源。 */
export interface EvaluationRepository {
  createDataset(
    context: AccessContext,
    command: CreateEvaluationDatasetCommand,
  ): Promise<EvaluationDataset>;
  activateDataset(context: AccessContext, datasetId: string): Promise<EvaluationDataset>;
  listDatasets(context: AccessContext): Promise<readonly EvaluationDataset[]>;
  getDataset(context: AccessContext, datasetId: string): Promise<EvaluationDataset>;
  listCases(context: AccessContext, datasetId: string): Promise<readonly EvaluationCase[]>;
  resolveManifestIds(context: AccessContext, datasetId: string): Promise<readonly string[]>;
  createRun(context: AccessContext, command: CreateEvaluationRunCommand): Promise<EvaluationRun>;
  listRuns(context: AccessContext): Promise<readonly EvaluationRun[]>;
  getRunDetail(context: AccessContext, runId: string): Promise<EvaluationRunDetail>;
  promoteBaseline(
    context: AccessContext,
    runId: string,
    name: string,
    reason: string,
  ): Promise<EvaluationBaseline>;
  claimCases(
    workerId: string,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<readonly ClaimedEvaluationCase[]>;
  attachRagRun(resultId: string, workerId: string, ragRunId: string): Promise<void>;
  releaseCase(resultId: string, workerId: string, delaySeconds: number): Promise<void>;
  completeCase(
    resultId: string,
    workerId: string,
    actual: EvaluationActual,
    scores: Readonly<Record<string, number>>,
    failureCodes: readonly string[],
    passed: boolean,
    durationMs: number,
  ): Promise<EvaluationCaseResult>;
  failCase(resultId: string, workerId: string, code: string, terminal: boolean): Promise<void>;
  claimReadyRuns(
    workerId: string,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<readonly ReadyEvaluationRun[]>;
  finalizeRun(
    runId: string,
    workerId: string,
    metrics: readonly EvaluationMetric[],
    regressions: readonly string[],
  ): Promise<void>;
}

/** RAG Case 执行器读取真实问答终态；Parser/Chunk fixture 不经过此端口。 */
export interface EvaluationQuestionRunnerPort {
  start(task: ClaimedEvaluationCase): Promise<string>;
  read(task: ClaimedEvaluationCase): Promise<
    | { readonly status: 'PENDING' }
    | { readonly status: 'FAILED'; readonly code: string }
    | {
        readonly status: 'COMPLETED';
        readonly actual: EvaluationActual;
        readonly durationMs: number;
      }
  >;
}

/** 依赖注入 Token。 */
export const EVALUATION_REPOSITORY = Symbol('EVALUATION_REPOSITORY');
/** 真实问题执行端口 Token。 */
export const EVALUATION_QUESTION_RUNNER = Symbol('EVALUATION_QUESTION_RUNNER');
