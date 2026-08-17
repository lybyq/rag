/**
 * M04 结构恢复、专用 Chunk、去重和质量门禁编排用例。
 * 纯算法位于 chunking 库，事务和任务状态位于 Repository；本服务只组织执行顺序和失败边界。
 *
 * @requirement KNO-002
 * @requirement KNO-003
 * @requirement KNO-007
 * @requirement KNO-008
 * @requirement KNO-009
 * @requirement KNO-010
 * @requirement KNO-013
 */
import {
  buildKnowledgeChunks,
  evaluateDocumentQuality,
  type ChunkingPolicy,
  type QualityPolicyConfig,
  type TextTokenizer,
} from '@rag/chunking';
import type { QualityVerdict } from '@rag/contracts';
import type { KnowledgeProcessingRepository } from './knowledge-processing.ports';

/** M04 算法配置；revision 必须改变后生成新的 content revision。 */
export interface KnowledgeProcessingConfig {
  readonly chunkerProfileId: string;
  readonly chunkerRevision: string;
  readonly qualityRuleVersion: string;
  readonly chunking: ChunkingPolicy;
  readonly quality: QualityPolicyConfig;
}

/** Worker 上报的稳定处理结果。 */
export type KnowledgeProcessingOutcome = QualityVerdict | 'NOT_CLAIMABLE' | 'FAILED';

/** M04 单文档处理用例。 */
export class KnowledgeProcessingService {
  public constructor(
    private readonly repository: KnowledgeProcessingRepository,
    private readonly tokenizer: TextTokenizer,
    private readonly config: KnowledgeProcessingConfig,
  ) {}

  /**
   * 执行一次 M04 Run。
   * 运行异常转为 WAITING 供排查，不自动无限重试，因为纯算法异常通常代表数据或开发缺陷。
   */
  public async process(jobId: string, workerId: string): Promise<KnowledgeProcessingOutcome> {
    const startedAt = Date.now();
    let processingRunId: string | null = null;
    try {
      const input = await this.repository.loadInput(jobId, workerId);
      if (!input) return 'NOT_CLAIMABLE';
      const run = await this.repository.beginRun({
        input,
        workerId,
        chunkerProfileId: this.config.chunkerProfileId,
        chunkerRevision: this.config.chunkerRevision,
        tokenizerProfileId: this.tokenizer.profileId,
        tokenizerRevision: this.tokenizer.revision,
        qualityRuleVersion: this.config.qualityRuleVersion,
      });
      processingRunId = run.id;
      await this.repository.startStep(
        jobId,
        workerId,
        'CHUNK',
        0,
        input.blocks.length || null,
        '正在恢复结构并生成 Chunk',
      );
      const built = buildKnowledgeChunks(
        {
          documentVersionId: input.documentVersionId,
          contentRevision: input.contentRevision,
          fileFormat: input.fileFormat,
          blocks: input.blocks,
        },
        this.tokenizer,
        this.config.chunking,
      );
      await this.repository.startStep(
        jobId,
        workerId,
        'QUALITY_GATE',
        input.blocks.length,
        input.blocks.length || null,
        '正在执行自动质量门禁',
      );
      const quality = evaluateDocumentQuality(
        {
          blocks: input.blocks,
          chunks: built.chunks,
          expectedPageCount: input.expectedPageCount,
          hasResponsibleOwner: input.hasResponsibleOwner,
          versionConsistent: input.versionConsistent,
        },
        this.config.quality,
      );
      await this.repository.complete({
        jobId,
        workerId,
        processingRunId,
        chunks: built.chunks,
        relations: built.relations,
        quality,
        durationMs: Date.now() - startedAt,
      });
      return quality.verdict;
    } catch (error) {
      const publicMessage = error instanceof Error ? error.message.slice(0, 500) : '知识加工失败';
      await this.repository.fail({
        jobId,
        workerId,
        processingRunId,
        failureCode: 'KNOWLEDGE_PROCESSING_FAILED',
        publicMessage,
      });
      return 'FAILED';
    }
  }
}
