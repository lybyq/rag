/**
 * M05 索引运行、Manifest、回滚和 Profile 重建管理用例。
 * Repository 在数据库事实层再次执行空间 ACL；本服务负责稳定的 NOT_FOUND 映射和命令语义。
 *
 * @requirement IDX-010
 * @requirement IDX-012
 * @requirement IDX-016
 */
import type {
  IndexingRun,
  IndexRebuild,
  IndexRebuildDecisionRequest,
  IndexReconciliationReport,
  RollbackManifestRequest,
  SpaceManifest,
  StartIndexRebuildRequest,
} from '@rag/contracts';
import { ApplicationError } from './application.error';
import type { IndexingRepository } from './indexing.ports';
import type { AccessContext } from './ports';

/** Platform API 使用的 M05 管理服务。 */
export class IndexingAdminService {
  public constructor(private readonly repository: IndexingRepository) {}

  /** 读取单次索引运行；无权限与不存在统一返回 404，避免枚举资源。 */
  public async getRun(context: AccessContext, indexingRunId: string): Promise<IndexingRun> {
    const run = await this.repository.getRun(context, indexingRunId);
    if (!run) throw new ApplicationError('NOT_FOUND', 404, '索引运行不存在');
    return run;
  }

  /** 读取 Profile rollout 的构建、评测和灰度状态。 */
  public async getRebuild(
    context: AccessContext,
    spaceId: string,
    requestId: string,
  ): Promise<IndexRebuild> {
    const rebuild = await this.repository.getProfileRebuild(context, spaceId, requestId);
    if (!rebuild) throw new ApplicationError('NOT_FOUND', 404, 'Profile 重建请求不存在');
    return rebuild;
  }

  /** 将 READY CANARY 原子提升为稳定 Head。 */
  public promoteRebuild(
    context: AccessContext,
    spaceId: string,
    requestId: string,
    request: IndexRebuildDecisionRequest,
  ): Promise<SpaceManifest> {
    return this.repository.promoteProfileRebuild(context, spaceId, requestId, request.reason);
  }

  /** 按请求记录的一开始稳定版本回退，不接受客户端自填 Collection。 */
  public rollbackRebuild(
    context: AccessContext,
    spaceId: string,
    requestId: string,
    request: IndexRebuildDecisionRequest,
  ): Promise<SpaceManifest> {
    return this.repository.rollbackProfileRebuild(context, spaceId, requestId, request.reason);
  }

  /** 读取不可变发布前对账报告。 */
  public async getReconciliation(
    context: AccessContext,
    indexingRunId: string,
  ): Promise<IndexReconciliationReport> {
    const report = await this.repository.getReconciliation(context, indexingRunId);
    if (!report) throw new ApplicationError('NOT_FOUND', 404, '索引对账报告不存在');
    return report;
  }

  /** 列出空间全部 Manifest 历史及当前 ACTIVE 状态。 */
  public listManifests(context: AccessContext, spaceId: string): Promise<readonly SpaceManifest[]> {
    return this.repository.listManifests(context, spaceId);
  }

  /** 回滚只接受目标版本号，不接受客户端指定 Collection 或 Manifest 状态。 */
  public rollback(
    context: AccessContext,
    spaceId: string,
    request: RollbackManifestRequest,
  ): Promise<SpaceManifest> {
    return this.repository.rollback(context, spaceId, request);
  }

  /** 创建可审计的全量/灰度重建任务。 */
  public async rebuild(
    context: AccessContext,
    spaceId: string,
    request: StartIndexRebuildRequest,
  ): Promise<{ readonly requestId: string }> {
    return {
      requestId: await this.repository.enqueueProfileRebuild(
        context,
        spaceId,
        request.embeddingProfileId,
        request.mode,
        request.canaryPercent,
        request.reason,
      ),
    };
  }
}
