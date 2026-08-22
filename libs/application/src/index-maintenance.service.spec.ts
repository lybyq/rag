/** M05 跨存储对账、修复、人工处理和清理安全边界测试。 */
import type {
  IndexMaintenanceRepository,
  IndexMaintenanceTask,
  IndexVectorRecord,
  VectorIndexPort,
} from './indexing.ports';
import type { ObjectStoragePort } from './ingestion.ports';
import { IndexMaintenanceService } from './index-maintenance.service';

describe('[IDX-014][IDX-015] IndexMaintenanceService', () => {
  it('ACTIVE Manifest 仅补写缺失向量，对账恢复后定时再排队', async () => {
    const repository = repositoryMock('ACTIVE');
    const vector = vectorMock();
    (vector.listManifestRecordFacts as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { vectorId: 'a'.repeat(64), contentSha256: 'b'.repeat(64), embeddingProfileId: 'profile' },
      ]);
    (vector.lookupRecordIds as jest.Mock).mockResolvedValue(['a'.repeat(64)]);
    const service = createService(repository, vector);

    await expect(service.process(task('RECONCILE_MANIFEST'), 'worker')).resolves.toBe('REPAIRED');

    expect(vector.deleteManifestRecords).not.toHaveBeenCalled();
    expect(vector.upsertManifestRecords).toHaveBeenCalledTimes(1);
    expect(repository.completeMaintenanceTask).toHaveBeenCalledWith(
      'task-1',
      'worker',
      expect.objectContaining({ repaired: true }),
      expect.any(Date),
    );
  });

  it('Hash/Profile 异常不自动重建 ACTIVE Manifest，而是进入人工处理', async () => {
    const repository = repositoryMock('ACTIVE');
    const vector = vectorMock();
    (vector.listManifestRecordFacts as jest.Mock).mockResolvedValue([
      { vectorId: 'a'.repeat(64), contentSha256: 'f'.repeat(64), embeddingProfileId: 'wrong' },
    ]);
    const service = createService(repository, vector);

    await expect(service.process(task('RECONCILE_MANIFEST'), 'worker')).resolves.toBe('MANUAL');

    expect(vector.upsertManifestRecords).not.toHaveBeenCalled();
    expect(vector.deleteManifestRecords).not.toHaveBeenCalled();
    expect(repository.releaseMaintenanceTask).toHaveBeenCalledWith(
      'task-1',
      'worker',
      expect.stringContaining('不可安全自动修复'),
      3600,
      true,
    );
  });

  it('旧 Manifest 重新激活后，过期清理任务必须拒绝删除', async () => {
    const repository = repositoryMock('ACTIVE');
    const vector = vectorMock();
    const service = createService(repository, vector);

    await expect(service.process(task('CLEANUP_MANIFEST'), 'worker')).resolves.toBe('RETRY');
    expect(vector.deleteManifestRecords).not.toHaveBeenCalled();
  });

  it('SUPERSEDED Manifest 清理失败只回到维护队列，不影响线上版本', async () => {
    const repository = repositoryMock('SUPERSEDED');
    const vector = vectorMock();
    (vector.deleteManifestRecords as jest.Mock).mockRejectedValue(new Error('milvus down'));
    const service = createService(repository, vector);

    await expect(service.process(task('CLEANUP_MANIFEST'), 'worker')).resolves.toBe('RETRY');
    expect(repository.releaseMaintenanceTask).toHaveBeenCalledWith(
      'task-1',
      'worker',
      'milvus down',
      30,
      false,
    );
  });
});

function createService(
  repository: IndexMaintenanceRepository,
  vector: VectorIndexPort,
): IndexMaintenanceService {
  return new IndexMaintenanceService(repository, vector, storageMock(), {
    requestTimeoutMs: 1000,
    reconcileIntervalSeconds: 3600,
    maxAttempts: 3,
  });
}

function task(taskType: IndexMaintenanceTask['taskType']): IndexMaintenanceTask {
  return {
    id: 'task-1',
    taskType,
    manifestId: '11111111-1111-4111-8111-111111111111',
    collectionName: 'rag_test',
    manifestStatus: 'ACTIVE',
    attempts: 1,
  };
}

function repositoryMock(
  status: 'ACTIVE' | 'SUPERSEDED',
): IndexMaintenanceRepository & Record<string, jest.Mock> {
  return {
    claimMaintenanceTasks: jest.fn(async () => []),
    loadMaintenanceSnapshot: jest.fn(async () => ({
      manifest: {
        id: '11111111-1111-4111-8111-111111111111',
        spaceId: '22222222-2222-4222-8222-222222222222',
        version: 1,
        status,
        providerProfile: 'test' as const,
        embeddingProfileId: 'profile',
        embeddingModelId: 'model',
        embeddingModelRevision: 'r1',
        tokenizerRevision: 't1',
        denseDimension: 2,
        normalizeDense: true,
        sparseFormatVersion: null,
        collectionName: 'rag_test',
        expectedVectorCount: 1,
        actualVectorCount: 1,
        reconciliationSha256: null,
        activatedAt: status === 'ACTIVE' ? new Date().toISOString() : null,
        createdAt: new Date().toISOString(),
      },
      records: [record()],
      sourceObjects: [{ bucket: 'uploads', objectKey: 'safe/key', sha256: 'c'.repeat(64) }],
    })),
    completeMaintenanceTask: jest.fn(async () => undefined),
    releaseMaintenanceTask: jest.fn(async () => undefined),
  } as unknown as IndexMaintenanceRepository & Record<string, jest.Mock>;
}

function vectorMock(): VectorIndexPort & Record<string, jest.Mock> {
  return {
    ensureProfileCollection: jest.fn(async () => undefined),
    upsertManifestRecords: jest.fn(async (collection, records: readonly IndexVectorRecord[]) => ({
      succeededVectorIds: records.map((item) => item.vectorId),
      retryableVectorIds: [],
      terminalVectorIds: [],
    })),
    listManifestRecordFacts: jest.fn(async () => []),
    lookupRecordIds: jest.fn(async () => []),
    deleteManifestRecords: jest.fn(async () => undefined),
  } as unknown as VectorIndexPort & Record<string, jest.Mock>;
}

function storageMock(): ObjectStoragePort {
  return {
    headObject: jest.fn(async () => ({ sizeBytes: 1, sha256: 'c'.repeat(64) })),
  } as unknown as ObjectStoragePort;
}

function record(): IndexVectorRecord {
  return {
    vectorId: 'a'.repeat(64),
    manifestId: '11111111-1111-4111-8111-111111111111',
    spaceId: '22222222-2222-4222-8222-222222222222',
    documentId: '33333333-3333-4333-8333-333333333333',
    documentVersionId: '44444444-4444-4444-8444-444444444444',
    contentRevision: 1,
    chunkId: 'chunk-1',
    ordinal: 1,
    contentSha256: 'b'.repeat(64),
    embeddingProfileId: 'profile',
    shortSummary: '摘要',
    headingPath: [],
    sourceLocations: [],
    dense: [1, 0],
    sparse: null,
  };
}
