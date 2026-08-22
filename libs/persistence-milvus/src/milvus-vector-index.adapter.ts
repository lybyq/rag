/**
 * M05 Milvus 向量索引 Adapter。
 *
 * Collection Schema 只保存过滤字段、短摘要、定位元数据和向量，不保存完整正文。
 * 所有 Filter 都由本文件从已验证 UUID/SHA 主键构造，业务输入不能直接成为 Milvus 表达式。
 * SDK 不原生接受 AbortSignal，因此每次 RPC 同时传 timeout 并在等待边界监听取消。
 *
 * @requirement IDX-006
 * @requirement IDX-007
 * @requirement IDX-009
 * @requirement IDX-010
 */
import type { OnModuleDestroy } from '@nestjs/common';
import type {
  IndexVectorRecord,
  IndexedRecordFact,
  ProviderCallOptions,
  VectorIndexPort,
  VectorSearchHit,
  VectorWriteResult,
} from '@rag/application';
import type { AppConfig } from '@rag/config';
import type { EmbeddingProfile } from '@rag/contracts';
import { DataType, MetricType, MilvusClient } from '@zilliz/milvus2-sdk-node';

/** 契约测试注入的最小 SDK 表面，隔离 Milvus SDK 的宽泛 any 类型。 */
export interface MilvusIndexSdkClient {
  hasCollection(data: Record<string, unknown>): Promise<unknown>;
  createCollection(data: Record<string, unknown>): Promise<unknown>;
  describeCollection(data: Record<string, unknown>): Promise<unknown>;
  createAlias(data: Record<string, unknown>): Promise<unknown>;
  alterAlias(data: Record<string, unknown>): Promise<unknown>;
  loadCollection(data: Record<string, unknown>): Promise<unknown>;
  upsert(data: Record<string, unknown>): Promise<unknown>;
  query(data: Record<string, unknown>): Promise<unknown>;
  search(data: Record<string, unknown>): Promise<unknown>;
  delete(data: Record<string, unknown>): Promise<unknown>;
  closeConnection(): Promise<unknown>;
}

/** 真实 Milvus Adapter，也允许测试注入最小客户端。 */
export class MilvusVectorIndexAdapter implements VectorIndexPort, OnModuleDestroy {
  private client: MilvusIndexSdkClient | undefined;
  private readonly createClient: () => MilvusIndexSdkClient;

  public constructor(config: AppConfig, client?: MilvusIndexSdkClient) {
    if (client) {
      this.client = client;
      this.createClient = () => client;
      return;
    }
    // Milvus SDK 构造器会立即连网。惰性工厂保证管理 API/测试不会因未使用的向量端口而连接 Milvus；
    // ingestion-worker 首次真正执行索引 RPC 时才建立连接，RPC 仍受 Deadline/Abort 约束。
    this.createClient = () =>
      new MilvusClient({
        address: config.milvus.address,
        timeout: config.milvus.requestTimeoutMs,
        ssl: config.milvus.tlsEnabled,
        database: config.milvus.database,
        ...(config.milvus.username ? { username: config.milvus.username } : {}),
        ...(config.milvus.password ? { password: config.milvus.password } : {}),
        ...(config.milvus.token ? { token: config.milvus.token } : {}),
      }) as unknown as MilvusIndexSdkClient;
  }

  /** 创建 Profile 专属 Schema；已存在时核验 Dense/Sparse 字段，禁止错误维度复用。 */
  public async ensureProfileCollection(
    profile: EmbeddingProfile,
    collectionName: string,
    aliasName: string,
    options: ProviderCallOptions,
  ): Promise<void> {
    const client = this.getClient();
    assertIdentifier(collectionName);
    assertIdentifier(aliasName);
    const timeout = rpcTimeout(options);
    const existence = asRecord(
      await abortable(
        client.hasCollection({ collection_name: collectionName, timeout }),
        options.signal,
      ),
    );
    const exists = existence.value === true;
    if (!exists) {
      const fields: Record<string, unknown>[] = [
        { name: 'vector_id', data_type: DataType.VarChar, max_length: 64, is_primary_key: true },
        {
          name: 'manifest_id',
          data_type: DataType.VarChar,
          max_length: 36,
          is_partition_key: true,
        },
        { name: 'space_id', data_type: DataType.VarChar, max_length: 36 },
        { name: 'document_id', data_type: DataType.VarChar, max_length: 36 },
        { name: 'document_version_id', data_type: DataType.VarChar, max_length: 36 },
        { name: 'content_revision', data_type: DataType.Int64 },
        { name: 'chunk_id', data_type: DataType.VarChar, max_length: 180 },
        { name: 'ordinal', data_type: DataType.Int64 },
        { name: 'content_sha256', data_type: DataType.VarChar, max_length: 64 },
        { name: 'embedding_profile_id', data_type: DataType.VarChar, max_length: 100 },
        { name: 'short_summary', data_type: DataType.VarChar, max_length: 512 },
        { name: 'heading_path', data_type: DataType.JSON },
        { name: 'source_locations', data_type: DataType.JSON },
        { name: 'dense_vector', data_type: DataType.FloatVector, dim: profile.denseDimension },
      ];
      const indexParams: Record<string, unknown>[] = [
        {
          field_name: 'dense_vector',
          index_type: 'HNSW',
          metric_type: MetricType.COSINE,
          params: { M: 16, efConstruction: 256 },
        },
      ];
      if (profile.sparseFormatVersion) {
        fields.push({ name: 'sparse_vector', data_type: DataType.SparseFloatVector });
        indexParams.push({
          field_name: 'sparse_vector',
          index_type: 'SPARSE_INVERTED_INDEX',
          metric_type: MetricType.IP,
          params: { drop_ratio_build: 0.2 },
        });
      }
      await abortable(
        client.createCollection({
          collection_name: collectionName,
          fields,
          index_params: indexParams,
          enable_dynamic_field: false,
          num_partitions: 64,
          timeout,
        }),
        options.signal,
      );
    } else {
      const described = asRecord(
        await abortable(
          client.describeCollection({ collection_name: collectionName, timeout }),
          options.signal,
        ),
      );
      assertExistingSchemaCompatible(described, profile);
    }
    try {
      await abortable(
        client.createAlias({ collection_name: collectionName, alias: aliasName, timeout }),
        options.signal,
      );
    } catch {
      await abortable(
        client.alterAlias({ collection_name: collectionName, alias: aliasName, timeout }),
        options.signal,
      );
    }
    await abortable(
      client.loadCollection({ collection_name: collectionName, timeout }),
      options.signal,
    );
  }

  /** Milvus upsert 的 succ_index/err_index 被转换为稳定部分失败语义。 */
  public async upsertManifestRecords(
    collectionName: string,
    records: readonly IndexVectorRecord[],
    options: ProviderCallOptions,
  ): Promise<VectorWriteResult> {
    const client = this.getClient();
    assertIdentifier(collectionName);
    if (records.length === 0) return emptyWriteResult();
    try {
      const response = asRecord(
        await abortable(
          client.upsert({
            collection_name: collectionName,
            data: records.map(toMilvusRow),
            timeout: rpcTimeout(options),
          }),
          options.signal,
        ),
      );
      const failed = numberArray(response.err_index);
      const succeeded = numberArray(response.succ_index);
      const succeededIndexes = new Set(
        succeeded.length > 0
          ? succeeded
          : records.map((_, index) => index).filter((index) => !failed.includes(index)),
      );
      return {
        succeededVectorIds: records
          .filter((_, index) => succeededIndexes.has(index))
          .map((record) => record.vectorId),
        retryableVectorIds: failed.map((index) => records[index]?.vectorId).filter(isString),
        terminalVectorIds: [],
      };
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason;
      const terminal = /dimension|schema|field|type/i.test(errorMessage(error));
      return {
        succeededVectorIds: [],
        retryableVectorIds: terminal ? [] : records.map((record) => record.vectorId),
        terminalVectorIds: terminal ? records.map((record) => record.vectorId) : [],
      };
    }
  }

  /** 分页读取 Manifest 的最小标量事实；不请求正文和向量字段。 */
  public async listManifestRecordFacts(
    collectionName: string,
    manifestId: string,
    options: ProviderCallOptions,
  ): Promise<readonly IndexedRecordFact[]> {
    const client = this.getClient();
    assertIdentifier(collectionName);
    assertUuid(manifestId);
    const rows: IndexedRecordFact[] = [];
    const pageSize = 10_000;
    for (let offset = 0; ; offset += pageSize) {
      const response = asRecord(
        await abortable(
          client.query({
            collection_name: collectionName,
            filter: `manifest_id == "${manifestId}"`,
            output_fields: ['vector_id', 'content_sha256', 'embedding_profile_id'],
            limit: pageSize,
            offset,
            timeout: rpcTimeout(options),
          }),
          options.signal,
        ),
      );
      const data = recordArray(response.data);
      for (const row of data) {
        if (
          typeof row.vector_id === 'string' &&
          typeof row.content_sha256 === 'string' &&
          typeof row.embedding_profile_id === 'string'
        ) {
          rows.push({
            vectorId: row.vector_id,
            contentSha256: row.content_sha256,
            embeddingProfileId: row.embedding_profile_id,
          });
        }
      }
      if (data.length < pageSize) break;
    }
    return rows;
  }

  /** 固定关键查询按精确主键集合读取，用于验证可检索标量和过滤条件。 */
  public async lookupRecordIds(
    collectionName: string,
    manifestId: string,
    vectorIds: readonly string[],
    options: ProviderCallOptions,
  ): Promise<readonly string[]> {
    const client = this.getClient();
    assertIdentifier(collectionName);
    assertUuid(manifestId);
    for (const vectorId of vectorIds) assertSha256(vectorId);
    if (vectorIds.length === 0) return [];
    const literalIds = vectorIds.map((id) => `"${id}"`).join(',');
    const response = asRecord(
      await abortable(
        client.query({
          collection_name: collectionName,
          filter: `manifest_id == "${manifestId}" and vector_id in [${literalIds}]`,
          output_fields: ['vector_id'],
          limit: vectorIds.length,
          timeout: rpcTimeout(options),
        }),
        options.signal,
      ),
    );
    return recordArray(response.data)
      .map((row) => row.vector_id)
      .filter(isString);
  }

  /** Candidate Manifest 的 Dense 离线查询；Manifest UUID 由服务端校验后构造 Filter。 */
  public async searchManifestDense(
    collectionName: string,
    manifestId: string,
    dense: readonly number[],
    limit: number,
    options: ProviderCallOptions,
  ): Promise<readonly VectorSearchHit[]> {
    const client = this.getClient();
    assertIdentifier(collectionName);
    assertUuid(manifestId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Milvus 查询 limit 非法');
    if (dense.length === 0 || dense.some((value) => !Number.isFinite(value))) {
      throw new Error('Milvus 查询向量非法');
    }
    const response = asRecord(
      await abortable(
        client.search({
          collection_name: collectionName,
          anns_field: 'dense_vector',
          data: [[...dense]],
          filter: `manifest_id == "${manifestId}"`,
          limit,
          metric_type: MetricType.COSINE,
          output_fields: ['vector_id', 'document_id'],
          timeout: rpcTimeout(options),
        }),
        options.signal,
      ),
    );
    const raw =
      Array.isArray(response.results) && Array.isArray(response.results[0])
        ? response.results[0]
        : (response.results ?? response.data);
    return recordArray(raw)
      .map((row) => ({
        vectorId: String(row.vector_id ?? row.id ?? ''),
        documentId: String(row.document_id ?? asRecord(row.entity).document_id ?? ''),
        score: Number(row.score ?? row.distance ?? 0),
      }))
      .filter(
        (row) => /^[a-f0-9]{64}$/.test(row.vectorId) && /^[a-f0-9-]{36}$/i.test(row.documentId),
      );
  }

  /** 只允许按服务端 Manifest UUID 删除；调用方不能提交任意 Milvus Filter。 */
  public async deleteManifestRecords(
    collectionName: string,
    manifestId: string,
    options: ProviderCallOptions,
  ): Promise<void> {
    const client = this.getClient();
    assertIdentifier(collectionName);
    assertUuid(manifestId);
    await abortable(
      client.delete({
        collection_name: collectionName,
        filter: `manifest_id == "${manifestId}"`,
        timeout: rpcTimeout(options),
      }),
      options.signal,
    );
  }

  public async onModuleDestroy(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.closeConnection().catch(() => undefined);
  }

  /** 只在业务首次调用时创建 SDK 客户端，避免 import 模块产生隐式网络副作用。 */
  private getClient(): MilvusIndexSdkClient {
    this.client ??= this.createClient();
    return this.client;
  }
}

function toMilvusRow(record: IndexVectorRecord): Record<string, unknown> {
  return {
    vector_id: record.vectorId,
    manifest_id: record.manifestId,
    space_id: record.spaceId,
    document_id: record.documentId,
    document_version_id: record.documentVersionId,
    content_revision: record.contentRevision,
    chunk_id: record.chunkId,
    ordinal: record.ordinal,
    content_sha256: record.contentSha256,
    embedding_profile_id: record.embeddingProfileId,
    short_summary: record.shortSummary,
    heading_path: [...record.headingPath],
    source_locations: [...record.sourceLocations],
    dense_vector: [...record.dense],
    ...(record.sparse
      ? {
          sparse_vector: Object.fromEntries(
            record.sparse.indices.map((index, offset) => [
              index,
              record.sparse?.values[offset] ?? 0,
            ]),
          ),
        }
      : {}),
  };
}

function assertExistingSchemaCompatible(
  description: Record<string, unknown>,
  profile: EmbeddingProfile,
): void {
  const schema = asRecord(description.schema);
  const fields = recordArray(schema.fields ?? description.fields);
  const dense = fields.find((field) => field.name === 'dense_vector');
  const denseDimension = Number(dense?.dim ?? asRecord(dense?.type_params).dim ?? 0);
  if (denseDimension !== profile.denseDimension) {
    throw new Error('Milvus Collection Dense dimension 与 Embedding Profile 不兼容');
  }
  const hasSparse = fields.some((field) => field.name === 'sparse_vector');
  if (hasSparse !== Boolean(profile.sparseFormatVersion)) {
    throw new Error('Milvus Collection Sparse Schema 与 Embedding Profile 不兼容');
  }
}

function rpcTimeout(options: ProviderCallOptions): number {
  const remaining = options.deadlineAt.getTime() - Date.now();
  if (remaining <= 0) throw new Error('Milvus Deadline 已到期');
  return Math.max(1, Math.min(options.timeoutMs, remaining));
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(value)) throw new Error('Milvus 标识符非法');
}

function assertUuid(value: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw new Error('Manifest UUID 非法');
  }
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('向量主键非法');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isInteger) : [];
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyWriteResult(): VectorWriteResult {
  return { succeededVectorIds: [], retryableVectorIds: [], terminalVectorIds: [] };
}
