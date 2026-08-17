/**
 * M04 管理查询和审核用例。
 * 查询由 Repository 按 ACL 收窄；写操作先要求 REVIEW 权限，再由数据库事务执行乐观锁和审计。
 *
 * @requirement KNO-011
 * @requirement KNO-012
 * @requirement KNO-013
 */
import type { AuthorizationService } from './authorization.service';
import type {
  DocumentQualityReport,
  KnowledgeProcessingRun,
  ListKnowledgeChunksQuery,
  QualityFinding,
  ReviewQualityRequest,
} from '@rag/contracts';
import type {
  KnowledgeChunkPage,
  KnowledgeProcessingRepository,
  ReviewKnowledgeQualityResult,
} from './knowledge-processing.ports';
import { ApplicationError } from './application.error';
import type { AccessContext } from './ports';

/** M04 管理端 Use Case。 */
export class KnowledgeProcessingAdminService {
  public constructor(
    private readonly repository: KnowledgeProcessingRepository,
    private readonly authorization: Pick<AuthorizationService, 'requireResourcePermission'>,
  ) {}

  /** 列出一个文档版本保留的全部加工 revision。 */
  public listRuns(
    context: AccessContext,
    documentVersionId: string,
  ): Promise<readonly KnowledgeProcessingRun[]> {
    return this.repository.listRuns(context, documentVersionId);
  }

  /** 读取质量报告及稳定发现项。 */
  public async getRun(
    context: AccessContext,
    processingRunId: string,
  ): Promise<{
    run: KnowledgeProcessingRun;
    report: DocumentQualityReport;
    findings: readonly QualityFinding[];
  }> {
    const detail = await this.repository.getRun(context, processingRunId);
    if (!detail) throw new ApplicationError('NOT_FOUND', 404, '知识加工运行不存在');
    return detail;
  }

  /** 按稳定 ordinal 分页读取 Parent/Child Chunk。 */
  public listChunks(
    context: AccessContext,
    processingRunId: string,
    query: ListKnowledgeChunksQuery,
  ): Promise<KnowledgeChunkPage> {
    return this.repository.listChunks(context, processingRunId, query);
  }

  /** 审核权限来自知识空间 ACL，不接受客户端自报角色或空间 ID。 */
  public async review(
    context: AccessContext,
    processingRunId: string,
    request: ReviewQualityRequest,
  ): Promise<ReviewKnowledgeQualityResult> {
    await this.authorization.requireResourcePermission(
      context,
      'KNOWLEDGE_RUN',
      processingRunId,
      'REVIEW',
    );
    return this.repository.review({
      context,
      processingRunId,
      action: request.action,
      expectedVersion: request.expectedVersion,
      reason: request.reason,
    });
  }
}
