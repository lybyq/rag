/**
 * M04 知识加工、质量门禁和审核端口。
 * Application 只依赖这些稳定接口，不知道 PostgreSQL 表结构、BullMQ 或 Tokenizer 包实现。
 *
 * @requirement KNO-001
 * @requirement KNO-011
 * @requirement KNO-012
 * @requirement KNO-014
 */
import type {
  DocumentBlock,
  DocumentQualityReport,
  KnowledgeChunk,
  KnowledgeProcessingRun,
  ListKnowledgeChunksQuery,
  QualityFinding,
  QualityReviewAction,
  ProviderProfile,
  SupportedFileFormat,
} from '@rag/contracts';
import type {
  ChunkRelationDraft,
  KnowledgeChunkDraft,
  QualityEvaluationResult,
} from '@rag/chunking';
import type { AccessContext } from './ports';

/** Worker 从 PostgreSQL 加载的 M04 单一可信输入。 */
export interface KnowledgeProcessingInput {
  readonly jobId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly parseRunId: string;
  readonly fileFormat: SupportedFileFormat;
  readonly expectedPageCount: number;
  readonly hasResponsibleOwner: boolean;
  readonly versionConsistent: boolean;
  readonly blocks: readonly DocumentBlock[];
}

/** 创建或恢复 M04 Run 时锁定全部算法 revision。 */
export interface BeginKnowledgeProcessingCommand {
  readonly input: KnowledgeProcessingInput;
  /** 当前 lease owner；Repository 必须用它执行 fencing，不能只检查“存在某个租约”。 */
  readonly workerId: string;
  /** 当前部署画像；用于证明该 Run 属于外网演练还是内网环境。 */
  readonly providerProfile: ProviderProfile;
  readonly chunkerProfileId: string;
  readonly chunkerRevision: string;
  readonly tokenizerProfileId: string;
  readonly tokenizerRevision: string;
  readonly qualityRuleVersion: string;
}

/** Chunk、关系、质量报告和任务状态必须在一个事务内提交。 */
export interface CompleteKnowledgeProcessingCommand {
  readonly jobId: string;
  readonly workerId: string;
  readonly processingRunId: string;
  readonly chunks: readonly KnowledgeChunkDraft[];
  readonly relations: readonly ChunkRelationDraft[];
  readonly quality: QualityEvaluationResult;
  readonly durationMs: number;
}

/** M04 失败只保存稳定代码和公开消息，不保存文档正文。 */
export interface FailKnowledgeProcessingCommand {
  readonly jobId: string;
  readonly workerId: string;
  readonly processingRunId: string | null;
  readonly failureCode: string;
  readonly publicMessage: string;
}

/** Chunk 游标页。 */
export interface KnowledgeChunkPage {
  readonly items: readonly KnowledgeChunk[];
  readonly nextOrdinal: number | null;
}

/** 审核事务命令；context 用于默认拒绝式二次校验和审计。 */
export interface ReviewKnowledgeQualityCommand {
  readonly context: AccessContext;
  readonly processingRunId: string;
  readonly action: QualityReviewAction;
  readonly expectedVersion: number;
  readonly reason: string;
}

/** 审核可以同时创建一个新的 content revision 任务。 */
export interface ReviewKnowledgeQualityResult {
  readonly report: DocumentQualityReport;
  readonly reprocessJobId: string | null;
}

/** M04 PostgreSQL 事实源端口。 */
export interface KnowledgeProcessingRepository {
  loadInput(jobId: string, workerId: string): Promise<KnowledgeProcessingInput | undefined>;
  beginRun(command: BeginKnowledgeProcessingCommand): Promise<KnowledgeProcessingRun>;
  startStep(
    jobId: string,
    workerId: string,
    step: 'CHUNK' | 'QUALITY_GATE',
    processedUnits: number,
    totalUnits: number | null,
    publicMessage: string,
  ): Promise<void>;
  complete(command: CompleteKnowledgeProcessingCommand): Promise<void>;
  fail(command: FailKnowledgeProcessingCommand): Promise<void>;
  listRuns(
    context: AccessContext,
    documentVersionId: string,
  ): Promise<readonly KnowledgeProcessingRun[]>;
  getRun(
    context: AccessContext,
    processingRunId: string,
  ): Promise<
    | {
        run: KnowledgeProcessingRun;
        report: DocumentQualityReport;
        findings: readonly QualityFinding[];
      }
    | undefined
  >;
  listChunks(
    context: AccessContext,
    processingRunId: string,
    query: ListKnowledgeChunksQuery,
  ): Promise<KnowledgeChunkPage>;
  review(command: ReviewKnowledgeQualityCommand): Promise<ReviewKnowledgeQualityResult>;
}

/** M04 依赖注入 Token。 */
export const KNOWLEDGE_PROCESSING_REPOSITORY = Symbol('KNOWLEDGE_PROCESSING_REPOSITORY');
