/**
 * M05 PostgreSQL、MinIO、Milvus 周期对账、修复和旧 Manifest 清理用例。
 *
 * ACTIVE Manifest 只允许补写缺失向量，不执行先删后写；Hash/Profile/来源对象异常进入人工处理。
 * SUPERSEDED Manifest 只有保留期任务到期且仍非 ACTIVE 时才会删除，失败不会影响当前可见性。
 *
 * @requirement IDX-014
 * @requirement IDX-015
 */
import type { ObjectStoragePort } from './ingestion.ports';
import type {
  IndexMaintenanceRepository,
  IndexMaintenanceTask,
  ProviderCallOptions,
  VectorIndexPort,
} from './indexing.ports';
import { reconcileManifestRecords } from '@rag/retrieval';

/** 周期维护的有限资源配置。 */
export interface IndexMaintenanceConfig {
  readonly requestTimeoutMs: number;
  readonly reconcileIntervalSeconds: number;
  readonly maxAttempts: number;
}

/** 单任务稳定结果，用于 Prometheus 固定标签。 */
export type IndexMaintenanceOutcome = 'CLEANED' | 'HEALTHY' | 'REPAIRED' | 'RETRY' | 'MANUAL';

/** M05 跨存储维护服务。 */
export class IndexMaintenanceService {
  public constructor(
    private readonly repository: IndexMaintenanceRepository,
    private readonly vectorIndex: VectorIndexPort,
    private readonly storage: ObjectStoragePort,
    private readonly config: IndexMaintenanceConfig,
  ) {}

  /** 处理一个已由数据库租约领取的任务。 */
  public async process(
    task: IndexMaintenanceTask,
    workerId: string,
    signal = new AbortController().signal,
  ): Promise<IndexMaintenanceOutcome> {
    try {
      const snapshot = await this.repository.loadMaintenanceSnapshot(task.manifestId);
      if (task.taskType === 'CLEANUP_MANIFEST') {
        if (snapshot.manifest.status === 'ACTIVE') {
          await this.repository.releaseMaintenanceTask(
            task.id,
            workerId,
            'Manifest 已重新激活，禁止清理',
            this.config.reconcileIntervalSeconds,
            false,
          );
          return 'RETRY';
        }
        await this.vectorIndex.deleteManifestRecords(
          snapshot.manifest.collectionName,
          snapshot.manifest.id,
          callOptions(this.config.requestTimeoutMs, signal),
        );
        await this.repository.completeMaintenanceTask(
          task.id,
          workerId,
          { deletedManifestId: snapshot.manifest.id },
          null,
        );
        return 'CLEANED';
      }

      const sourceIssueCount = await this.checkSourceObjects(snapshot.sourceObjects, signal);
      const actual = await this.vectorIndex.listManifestRecordFacts(
        snapshot.manifest.collectionName,
        snapshot.manifest.id,
        callOptions(this.config.requestTimeoutMs, signal),
      );
      const fixedIds = snapshot.records.slice(0, 3).map((record) => record.vectorId);
      const returnedIds = await this.vectorIndex.lookupRecordIds(
        snapshot.manifest.collectionName,
        snapshot.manifest.id,
        fixedIds,
        callOptions(this.config.requestTimeoutMs, signal),
      );
      let report = reconcileManifestRecords({
        manifestId: snapshot.manifest.id,
        embeddingProfileId: snapshot.manifest.embeddingProfileId,
        expected: snapshot.records.map((record) => ({
          vectorId: record.vectorId,
          contentSha256: record.contentSha256,
        })),
        actual,
        fixedQueryExpectedIds: fixedIds,
        fixedQueryReturnedIds: returnedIds,
      });
      const missingIds = new Set(
        report.issues
          .filter((issue) => issue.code === 'MISSING_PRIMARY_KEY' && issue.vectorId)
          .map((issue) => issue.vectorId as string),
      );
      const unsafeIssues = report.issues.some(
        (issue) => issue.code !== 'COUNT_MISMATCH' && issue.code !== 'MISSING_PRIMARY_KEY',
      );
      let repaired = false;
      if (missingIds.size > 0 && !unsafeIssues && sourceIssueCount === 0) {
        const missing = snapshot.records.filter((record) => missingIds.has(record.vectorId));
        const write = await this.vectorIndex.upsertManifestRecords(
          snapshot.manifest.collectionName,
          missing,
          callOptions(this.config.requestTimeoutMs, signal),
        );
        if (write.retryableVectorIds.length > 0 || write.terminalVectorIds.length > 0) {
          throw new Error('缺失向量修复写入未完成');
        }
        const repairedActual = await this.vectorIndex.listManifestRecordFacts(
          snapshot.manifest.collectionName,
          snapshot.manifest.id,
          callOptions(this.config.requestTimeoutMs, signal),
        );
        // 修复后必须再次执行固定主键查询；仅检查列表数量无法发现“数据存在但不可查询”的索引故障。
        const repairedReturnedIds = await this.vectorIndex.lookupRecordIds(
          snapshot.manifest.collectionName,
          snapshot.manifest.id,
          fixedIds,
          callOptions(this.config.requestTimeoutMs, signal),
        );
        report = reconcileManifestRecords({
          manifestId: snapshot.manifest.id,
          embeddingProfileId: snapshot.manifest.embeddingProfileId,
          expected: snapshot.records.map((record) => ({
            vectorId: record.vectorId,
            contentSha256: record.contentSha256,
          })),
          actual: repairedActual,
          fixedQueryExpectedIds: fixedIds,
          fixedQueryReturnedIds: repairedReturnedIds,
        });
        repaired = report.passed;
      }
      if (!report.passed || sourceIssueCount > 0) {
        await this.repository.releaseMaintenanceTask(
          task.id,
          workerId,
          '跨存储对账存在不可安全自动修复的问题',
          this.config.reconcileIntervalSeconds,
          true,
        );
        return 'MANUAL';
      }
      await this.repository.completeMaintenanceTask(
        task.id,
        workerId,
        {
          reportSha256: report.reportSha256,
          expectedCount: report.expectedCount,
          actualCount: report.actualCount,
          sourceObjectsChecked: snapshot.sourceObjects.length,
          repaired,
        },
        new Date(Date.now() + this.config.reconcileIntervalSeconds * 1_000),
      );
      return repaired ? 'REPAIRED' : 'HEALTHY';
    } catch (error) {
      const terminal = task.attempts >= this.config.maxAttempts;
      await this.repository.releaseMaintenanceTask(
        task.id,
        workerId,
        error instanceof Error ? error.message.slice(0, 500) : 'M05 维护失败',
        Math.min(3600, 30 * 2 ** Math.max(0, task.attempts - 1)),
        terminal,
      );
      return terminal ? 'MANUAL' : 'RETRY';
    }
  }

  private async checkSourceObjects(
    objects: readonly { bucket: string; objectKey: string; sha256: string | null }[],
    signal: AbortSignal,
  ): Promise<number> {
    let issues = 0;
    // 对象数通常等于文档数；逐个 HEAD 可避免维护器瞬时压垮内网 MinIO。
    for (const object of objects) {
      try {
        const head = await this.storage.headObject(object.bucket, object.objectKey, { signal });
        if (object.sha256 && head.sha256 && object.sha256 !== head.sha256) issues += 1;
      } catch {
        issues += 1;
      }
    }
    return issues;
  }
}

function callOptions(timeoutMs: number, signal: AbortSignal): ProviderCallOptions {
  return { signal, timeoutMs, deadlineAt: new Date(Date.now() + timeoutMs) };
}
