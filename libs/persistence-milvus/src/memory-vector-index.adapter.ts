/**
 * M05 外网测试用内存向量索引 Adapter。
 *
 * 它完整实现 Manifest 隔离、幂等 upsert、对账读取和删除语义，供 test/external-ci 使用。
 * 内网 staging/production 配置门禁禁止选择 memory，因此它不会冒充真实 Milvus 验收。
 *
 * @requirement IDX-009
 * @requirement CFG-002
 * @requirement CFG-003
 */
import type {
  IndexVectorRecord,
  IndexedRecordFact,
  ProviderCallOptions,
  VectorIndexPort,
  VectorSearchHit,
  VectorWriteResult,
} from '@rag/application';
import type { EmbeddingProfile } from '@rag/contracts';

interface MemoryCollection {
  readonly compatibilityKey: string;
  readonly records: Map<string, IndexVectorRecord>;
}

/** 进程内确定性向量索引，仅用于无基础设施测试。 */
export class MemoryVectorIndexAdapter implements VectorIndexPort {
  private readonly collections = new Map<string, MemoryCollection>();

  public ensureProfileCollection(
    profile: EmbeddingProfile,
    collectionName: string,
    _aliasName: string,
    options: ProviderCallOptions,
  ): Promise<void> {
    throwIfAborted(options.signal);
    const compatibilityKey = `${profile.profileId}:${profile.denseDimension}:${profile.sparseFormatVersion ?? 'none'}`;
    const existing = this.collections.get(collectionName);
    if (existing && existing.compatibilityKey !== compatibilityKey) {
      return Promise.reject(new Error('内存 Collection 与 Embedding Profile 不兼容'));
    }
    this.collections.set(
      collectionName,
      existing ?? { compatibilityKey, records: new Map<string, IndexVectorRecord>() },
    );
    return Promise.resolve();
  }

  public upsertManifestRecords(
    collectionName: string,
    records: readonly IndexVectorRecord[],
    options: ProviderCallOptions,
  ): Promise<VectorWriteResult> {
    throwIfAborted(options.signal);
    const collection = requireCollection(this.collections, collectionName);
    for (const record of records) collection.records.set(record.vectorId, structuredClone(record));
    return Promise.resolve({
      succeededVectorIds: records.map((record) => record.vectorId),
      retryableVectorIds: [],
      terminalVectorIds: [],
    });
  }

  public listManifestRecordFacts(
    collectionName: string,
    manifestId: string,
    options: ProviderCallOptions,
  ): Promise<readonly IndexedRecordFact[]> {
    throwIfAborted(options.signal);
    const collection = requireCollection(this.collections, collectionName);
    return Promise.resolve(
      [...collection.records.values()]
        .filter((record) => record.manifestId === manifestId)
        .map((record) => ({
          vectorId: record.vectorId,
          contentSha256: record.contentSha256,
          embeddingProfileId: record.embeddingProfileId,
        })),
    );
  }

  public lookupRecordIds(
    collectionName: string,
    manifestId: string,
    vectorIds: readonly string[],
    options: ProviderCallOptions,
  ): Promise<readonly string[]> {
    throwIfAborted(options.signal);
    const collection = requireCollection(this.collections, collectionName);
    return Promise.resolve(
      vectorIds.filter((vectorId) => collection.records.get(vectorId)?.manifestId === manifestId),
    );
  }

  /** 用余弦相似度执行确定性离线评测；仅返回文档主键和分数。 */
  public searchManifestDense(
    collectionName: string,
    manifestId: string,
    dense: readonly number[],
    limit: number,
    options: ProviderCallOptions,
  ): Promise<readonly VectorSearchHit[]> {
    throwIfAborted(options.signal);
    const collection = requireCollection(this.collections, collectionName);
    return Promise.resolve(
      [...collection.records.values()]
        .filter((record) => record.manifestId === manifestId)
        .map((record) => ({
          vectorId: record.vectorId,
          documentId: record.documentId,
          score: cosineSimilarity(dense, record.dense),
        }))
        .sort(
          (left, right) => right.score - left.score || left.vectorId.localeCompare(right.vectorId),
        )
        .slice(0, limit),
    );
  }

  public deleteManifestRecords(
    collectionName: string,
    manifestId: string,
    options: ProviderCallOptions,
  ): Promise<void> {
    throwIfAborted(options.signal);
    const collection = requireCollection(this.collections, collectionName);
    for (const [vectorId, record] of collection.records) {
      if (record.manifestId === manifestId) collection.records.delete(vectorId);
    }
    return Promise.resolve();
  }
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

function requireCollection(
  collections: ReadonlyMap<string, MemoryCollection>,
  collectionName: string,
): MemoryCollection {
  const collection = collections.get(collectionName);
  if (!collection) throw new Error('向量 Collection 尚未创建');
  return collection;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('已取消');
}
