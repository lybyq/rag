/**
 * M05 PostgreSQL Embedding 事实、Collection Registry、Manifest 与发布事务 Adapter。
 *
 * PostgreSQL 是“哪个 Manifest 在线”的唯一事实源；本 Adapter 不调用模型或 Milvus。
 * begin/publish 使用空间行锁和 Worker lease fencing，保证并发发布、消息重投和事务失败时旧版本不受影响。
 *
 * @requirement IDX-005
 * @requirement IDX-006
 * @requirement IDX-008
 * @requirement IDX-009
 * @requirement IDX-011
 * @requirement IDX-012
 * @requirement IDX-013
 * @requirement IDX-014
 * @requirement IDX-016
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ApplicationError,
  type AccessContext,
  type BeginIndexingRunCommand,
  type ChunkEmbeddingReference,
  type EmbeddingFact,
  type IndexBuildInput,
  type IndexMaintenanceRepository,
  type IndexMaintenanceSnapshot,
  type IndexMaintenanceTask,
  type IndexableChunk,
  type IndexingRepository,
  type IndexVectorRecord,
  type ProfileCandidateSnapshot,
  type ProfileRebuildTask,
  type ProfileRolloutRepository,
  type PublishManifestResult,
} from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import {
  EmbeddingOutputSchema,
  IndexRebuildSchema,
  IndexReconciliationReportSchema,
  IndexingRunSchema,
  ManifestDocumentMemberSchema,
  SpaceManifestSchema,
  type EmbeddingOutput,
  type EmbeddingProfile,
  type IndexingRun,
  type IndexRebuild,
  type IndexReconciliationReport,
  type ManifestDocumentMember,
  type RollbackManifestRequest,
  type SpaceManifest,
  type SparseVector,
} from '@rag/contracts';
import { INGESTION_STEP_ORDER, INGESTION_STEP_WEIGHTS } from '@rag/ingestion-core';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

interface IndexingRunRow {
  id: string;
  job_id: string;
  space_id: string;
  document_version_id: string;
  content_revision: number;
  embedding_revision: number;
  provider_profile: string;
  embedding_profile_id: string;
  embedding_model_id: string;
  embedding_model_revision: string;
  collection_name: string;
  manifest_id: string;
  manifest_version: number;
  status: string;
  expected_vector_count: number;
  embedded_count: number;
  reused_count: number;
  indexed_count: number;
  failure_code: string | null;
  failure_message: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ManifestRow {
  id: string;
  space_id: string;
  version: number;
  status: string;
  provider_profile: string;
  embedding_profile_id: string;
  embedding_model_id: string;
  embedding_model_revision: string;
  tokenizer_revision: string;
  dense_dimension: number;
  normalize_dense: boolean;
  sparse_format_version: string | null;
  collection_name: string;
  expected_vector_count: number;
  actual_vector_count: number;
  reconciliation_sha256: string | null;
  activated_at: Date | string | null;
  created_at: Date | string;
}

interface MemberRow {
  manifest_id: string;
  document_id: string;
  document_version_id: string;
  content_revision: number;
  embedding_revision: number;
  vector_count: number;
}

interface ChunkRow {
  chunk_id: string;
  document_id: string;
  document_version_id: string;
  content_revision: number;
  ordinal: number;
  embedding_text: string;
  display_content: string;
  token_count: number;
  content_sha256: string;
  heading_path: unknown;
  source_locations: unknown;
}

interface EmbeddingFactRow {
  id: string;
  embedding_profile_id: string;
  content_sha256: string;
  dense_vector: unknown;
  sparse_vector: unknown;
  model_id: string;
  model_revision: string;
}

interface RebuildRow {
  id: string;
  space_id: string;
  embedding_profile_id: string;
  mode: 'FULL' | 'CANARY';
  canary_percent: number;
  status: IndexRebuild['status'];
  candidate_manifest_id: string | null;
  previous_manifest_id: string | null;
  pipeline_job_id: string | null;
  evaluation_report: unknown;
  failure_code: string | null;
  failure_message: string | null;
  attempts: number;
  created_at: Date | string;
  completed_at: Date | string | null;
}

/** PostgreSQL M05 Repository。 */
@Injectable()
export class PostgresIndexingRepository
  implements IndexingRepository, IndexMaintenanceRepository, ProfileRolloutRepository
{
  private readonly collectionPrefix: string;
  private readonly activeAliasPrefix: string;
  private readonly retentionDays: number;

  public constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.collectionPrefix = sanitizeIdentifier(config.milvus.collectionPrefix);
    this.activeAliasPrefix = sanitizeIdentifier(config.milvus.activeAlias);
    this.retentionDays = config.indexing.manifestRetentionDays;
  }

  /**
   * 用兼容性摘要生成稳定 Collection/Alias，并在 PG Registry 中不可变登记。
   * 同一 profileId 如果被改了维度或 revision 会 fail-closed，不能静默指向新 Collection。
   */
  public async resolveProfileCollection(profile: EmbeddingProfile): Promise<{
    readonly collectionName: string;
    readonly aliasName: string;
  }> {
    const compatibilitySha256 = profileCompatibilitySha256(profile);
    const suffix = compatibilitySha256.slice(0, 16);
    const collectionName = `${this.collectionPrefix}_${suffix}`.slice(0, 255);
    const aliasName = `${this.activeAliasPrefix}_${suffix}`.slice(0, 255);
    await this.pool.query(
      `INSERT INTO embedding_collection_registry (
         embedding_profile_id, compatibility_sha256, provider_profile,
         model_id, model_revision, tokenizer_revision, dense_dimension,
         normalize_dense, sparse_format_version, document_template_version,
         query_template_version, collection_name, alias_name
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (embedding_profile_id) DO NOTHING`,
      [
        profile.profileId,
        compatibilitySha256,
        profile.providerProfile,
        profile.modelId,
        profile.revision,
        profile.tokenizerRevision,
        profile.denseDimension,
        profile.normalizeDense,
        profile.sparseFormatVersion,
        profile.documentTemplateVersion,
        profile.queryTemplateVersion,
        collectionName,
        aliasName,
      ],
    );
    const result = await this.pool.query<{
      compatibility_sha256: string;
      collection_name: string;
      alias_name: string;
      status: string;
    }>(
      `SELECT compatibility_sha256, collection_name, alias_name, status
         FROM embedding_collection_registry WHERE embedding_profile_id = $1`,
      [profile.profileId],
    );
    const row = requireRow(result.rows[0], 'Embedding Collection Registry 写入失败');
    if (row.compatibility_sha256 !== compatibilitySha256 || row.status !== 'ACTIVE') {
      throw new ApplicationError(
        'PROVIDER_PROFILE_MISMATCH',
        503,
        'Embedding Profile 与已登记 Collection 不兼容',
      );
    }
    return { collectionName: row.collection_name, aliasName: row.alias_name };
  }

  /** 锁定空间当前成员并创建下一个 BUILDING Manifest；重投恢复同一快照。 */
  public async beginRun(command: BeginIndexingRunCommand): Promise<IndexBuildInput | undefined> {
    const client = await this.pool.connect();
    let runId: string | undefined;
    try {
      await client.query('BEGIN');
      const target = await this.loadTargetForUpdate(client, command.jobId, command.workerId);
      if (!target) {
        await client.query('COMMIT');
        return undefined;
      }
      const existing = await client.query<IndexingRunRow>(
        'SELECT * FROM indexing_runs WHERE job_id = $1 FOR UPDATE',
        [command.jobId],
      );
      if (existing.rows[0]) {
        const run = existing.rows[0];
        if (run.embedding_profile_id !== command.profile.profileId) {
          throw new ApplicationError(
            'PROVIDER_PROFILE_MISMATCH',
            409,
            '重试任务的 Embedding Profile 已变化，必须创建新修订',
          );
        }
        await client.query(
          `UPDATE indexing_runs SET status = 'BUILDING', failure_code = NULL,
                  failure_message = NULL, started_at = now(), completed_at = NULL, updated_at = now()
            WHERE id = $1`,
          [run.id],
        );
        await client.query(
          `UPDATE space_manifests SET status = 'BUILDING', actual_vector_count = 0,
                  reconciliation_sha256 = NULL, updated_at = now()
            WHERE id = $1 AND status IN ('BUILDING','VERIFIED','FAILED')`,
          [run.manifest_id],
        );
        await client.query('DELETE FROM index_reconciliation_reports WHERE indexing_run_id = $1', [
          run.id,
        ]);
        runId = run.id;
      } else {
        await client.query('SELECT id FROM knowledge_spaces WHERE id = $1 FOR UPDATE', [
          target.space_id,
        ]);
        const versionResult = await client.query<{ next_version: number }>(
          `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
             FROM space_manifests WHERE space_id = $1`,
          [target.space_id],
        );
        const manifestVersion = requireRow(
          versionResult.rows[0],
          'Manifest 版本生成失败',
        ).next_version;
        const manifestResult = await client.query<{ id: string }>(
          `INSERT INTO space_manifests (
             space_id, version, status, provider_profile, embedding_profile_id,
             embedding_model_id, embedding_model_revision, tokenizer_revision,
             dense_dimension, normalize_dense, sparse_format_version, collection_name
           ) VALUES ($1,$2,'BUILDING',$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            target.space_id,
            manifestVersion,
            command.profile.providerProfile,
            command.profile.profileId,
            command.profile.modelId,
            command.profile.revision,
            command.profile.tokenizerRevision,
            command.profile.denseDimension,
            command.profile.normalizeDense,
            command.profile.sparseFormatVersion,
            command.collectionName,
          ],
        );
        const manifestId = requireRow(manifestResult.rows[0], 'Manifest 创建失败').id;

        // 先复制当前线上成员，再用目标文档的新版本覆盖。单文档发布不会让其他文档消失。
        await client.query(
          `INSERT INTO manifest_document_members (
             manifest_id, document_id, document_version_id, content_revision,
             embedding_revision, vector_count
           )
           SELECT $2, member.document_id, member.document_version_id, member.content_revision,
                  member.embedding_revision + CASE
                    WHEN old.embedding_profile_id = $3 THEN 0 ELSE 1 END,
                  member.vector_count
             FROM space_manifest_heads head
             JOIN space_manifests old ON old.id = head.active_manifest_id
             JOIN manifest_document_members member ON member.manifest_id = head.active_manifest_id
            WHERE head.space_id = $1 AND member.document_id <> $4`,
          [target.space_id, manifestId, command.profile.profileId, target.document_id],
        );
        const revisionResult = await client.query<{ next_revision: number }>(
          `SELECT COALESCE(MAX(member.embedding_revision), 0) + 1 AS next_revision
             FROM manifest_document_members member
             JOIN space_manifests manifest ON manifest.id = member.manifest_id
            WHERE manifest.space_id = $1 AND member.document_id = $2`,
          [target.space_id, target.document_id],
        );
        const embeddingRevision = requireRow(
          revisionResult.rows[0],
          'Embedding revision 生成失败',
        ).next_revision;
        const countResult = await client.query<{ vector_count: number }>(
          `SELECT count(*)::int AS vector_count FROM knowledge_chunks
            WHERE document_version_id = $1 AND content_revision = $2
              AND granularity = 'CHILD' AND eligible_for_index = true`,
          [target.document_version_id, target.content_revision],
        );
        const targetVectorCount = requireRow(
          countResult.rows[0],
          'Chunk 数量读取失败',
        ).vector_count;
        if (targetVectorCount === 0) {
          throw new ApplicationError('INVALID_STATE', 409, '没有可索引的合格 Child Chunk');
        }
        await client.query(
          `INSERT INTO manifest_document_members (
             manifest_id, document_id, document_version_id, content_revision,
             embedding_revision, vector_count
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            manifestId,
            target.document_id,
            target.document_version_id,
            target.content_revision,
            embeddingRevision,
            targetVectorCount,
          ],
        );
        const totalResult = await client.query<{ total: number }>(
          'SELECT COALESCE(sum(vector_count),0)::int AS total FROM manifest_document_members WHERE manifest_id = $1',
          [manifestId],
        );
        const expected = requireRow(totalResult.rows[0], 'Manifest 向量数量计算失败').total;
        await client.query(
          'UPDATE space_manifests SET expected_vector_count = $2, updated_at = now() WHERE id = $1',
          [manifestId, expected],
        );
        const runResult = await client.query<{ id: string }>(
          `INSERT INTO indexing_runs (
             job_id, space_id, document_version_id, content_revision, embedding_revision,
             provider_profile, embedding_profile_id, embedding_model_id,
             embedding_model_revision, collection_name, manifest_id, manifest_version,
             status, expected_vector_count
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'BUILDING',$13)
           RETURNING id`,
          [
            command.jobId,
            target.space_id,
            target.document_version_id,
            target.content_revision,
            embeddingRevision,
            command.profile.providerProfile,
            command.profile.profileId,
            command.profile.modelId,
            command.profile.revision,
            command.collectionName,
            manifestId,
            manifestVersion,
            expected,
          ],
        );
        runId = requireRow(runResult.rows[0], 'M05 Run 创建失败').id;
        await client.query(
          `INSERT INTO protected_resource_spaces (resource_type, resource_id, space_id)
           VALUES ('INDEX_RUN',$1,$2), ('SPACE_MANIFEST',$3,$2)
           ON CONFLICT (resource_type, resource_id) DO NOTHING`,
          [runId, target.space_id, manifestId],
        );
      }
      await client.query(
        `UPDATE indexing_runs SET status = 'EMBEDDING', updated_at = now() WHERE id = $1`,
        [runId],
      );
      await this.insertJobEvent(client, command.jobId, 'ingestion.m05_started', {
        indexingRunId: runId,
        embeddingProfileId: command.profile.profileId,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return runId ? this.loadBuildInput(runId) : undefined;
  }

  /** 步骤进度来自真实处理单位；切换步骤时原子完成前一个 M05 步骤。 */
  public async startStep(
    jobId: string,
    workerId: string,
    step: 'EMBED' | 'INDEX' | 'VERIFY' | 'PUBLISH',
    processedUnits: number,
    totalUnits: number,
    publicMessage: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, jobId, workerId);
      const previous = previousM05Step(step);
      if (previous) {
        await client.query(
          `UPDATE ingestion_job_steps SET status = 'SUCCEEDED',
                  processed_units = COALESCE(total_units, GREATEST(processed_units,1)),
                  total_units = COALESCE(total_units, GREATEST(processed_units,1)),
                  stage_percent = 100, overall_percent = $3,
                  finished_at = COALESCE(finished_at,now()), updated_at = now()
            WHERE job_id = $1 AND step_name = $2`,
          [jobId, previous, overallAtStep(step)],
        );
      }
      await client.query(
        `UPDATE ingestion_job_steps SET status = 'RUNNING', processed_units = $3::bigint,
                total_units = $4::bigint, stage_percent = CASE WHEN $4::bigint = 0 THEN 100
                  ELSE LEAST(100, ROUND(($3::numeric / $4::numeric) * 100, 2)) END,
                overall_percent = $5, public_message = $6,
                started_at = COALESCE(started_at,now()), heartbeat_at = now(), updated_at = now()
          WHERE job_id = $1 AND step_name = $2`,
        [jobId, step, processedUnits, totalUnits, overallAtStep(step), publicMessage],
      );
      await client.query(
        `UPDATE ingestion_jobs SET current_step = $3, overall_percent = $4,
                public_message = $5, heartbeat_at = now(), updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [jobId, workerId, step, overallAtStep(step), publicMessage],
      );
      await client.query(
        `UPDATE indexing_runs SET status = $2, updated_at = now() WHERE job_id = $1`,
        [jobId, runStatusAtStep(step)],
      );
      await this.insertJobEvent(client, jobId, 'ingestion.step_started', { step });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 批量读取可复用事实；正文 Hash 只作为等值条件，不进入动态 SQL。 */
  public async findEmbeddingFacts(
    embeddingProfileId: string,
    contentHashes: readonly string[],
  ): Promise<readonly EmbeddingFact[]> {
    if (contentHashes.length === 0) return [];
    const result = await this.pool.query<EmbeddingFactRow>(
      `SELECT id, embedding_profile_id, content_sha256::text, dense_vector, sparse_vector,
              model_id, model_revision
         FROM embedding_facts
        WHERE embedding_profile_id = $1 AND content_sha256::text = ANY($2::text[])`,
      [embeddingProfileId, [...contentHashes]],
    );
    return result.rows.map(mapEmbeddingFact);
  }

  /** INSERT DO NOTHING 保证并发相同 Hash 只创建一个事实，随后读取数据库真值。 */
  public async saveEmbeddingFacts(
    profile: EmbeddingProfile,
    outputs: readonly EmbeddingOutput[],
  ): Promise<readonly EmbeddingFact[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const raw of outputs) {
        const output = EmbeddingOutputSchema.parse(raw);
        await client.query(
          `INSERT INTO embedding_facts (
             embedding_profile_id, content_sha256, model_id, model_revision,
             dense_vector, sparse_vector, dense_dimension
           ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
           ON CONFLICT (embedding_profile_id, content_sha256) DO NOTHING`,
          [
            profile.profileId,
            output.contentSha256,
            output.modelId,
            output.revision,
            JSON.stringify(output.dense),
            output.sparse ? JSON.stringify(output.sparse) : null,
            output.dense.length,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const facts = await this.findEmbeddingFacts(
      profile.profileId,
      outputs.map((output) => output.contentSha256),
    );
    if (
      facts.some(
        (fact) =>
          fact.modelId !== profile.modelId ||
          fact.modelRevision !== profile.revision ||
          fact.dense.length !== profile.denseDimension,
      )
    ) {
      throw new ApplicationError(
        'PROVIDER_PROFILE_MISMATCH',
        409,
        '缓存 Embedding 事实与 Profile 不兼容',
      );
    }
    return facts;
  }

  /** 保存来源独立的 Chunk→Fact 关系；共享事实不会合并文档 ACL 或引用来源。 */
  public async saveChunkEmbeddingReferences(
    indexingRunId: string,
    references: readonly ChunkEmbeddingReference[],
    embeddedCount: number,
    reusedCount: number,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM chunk_embedding_refs WHERE indexing_run_id = $1', [
        indexingRunId,
      ]);
      for (const reference of references) {
        await client.query(
          `INSERT INTO chunk_embedding_refs (indexing_run_id, manifest_id, chunk_id, embedding_fact_id)
           SELECT id, manifest_id, $2, $3 FROM indexing_runs WHERE id = $1`,
          [indexingRunId, reference.chunkId, reference.embeddingFactId],
        );
      }
      await client.query(
        `UPDATE indexing_runs SET embedded_count = $2, reused_count = $3,
                status = 'INDEXING', updated_at = now() WHERE id = $1`,
        [indexingRunId, embeddedCount, reusedCount],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Milvus 写入完成仍不可见，只推进 Run 到 VERIFYING。 */
  public async markIndexed(indexingRunId: string, indexedCount: number): Promise<void> {
    const result = await this.pool.query(
      `UPDATE indexing_runs SET indexed_count = $2, status = 'VERIFYING', updated_at = now()
        WHERE id = $1 AND status IN ('INDEXING','VERIFYING')`,
      [indexingRunId, indexedCount],
    );
    if (result.rowCount !== 1)
      throw new ApplicationError('INVALID_STATE', 409, 'M05 Run 状态不允许确认索引');
  }

  /** 对账报告和 VERIFIED 状态在一个事务内提交；未通过报告绝不推进状态。 */
  public async markVerified(
    indexingRunId: string,
    report: IndexReconciliationReport,
  ): Promise<void> {
    if (!report.passed)
      throw new ApplicationError('INVALID_STATE', 409, '对账未通过，禁止标记 VERIFIED');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query<IndexingRunRow>(
        'SELECT * FROM indexing_runs WHERE id = $1 FOR UPDATE',
        [indexingRunId],
      );
      const row = requireRow(run.rows[0], 'M05 Run 不存在');
      if (row.manifest_id !== report.manifestId || row.status !== 'VERIFYING') {
        throw new ApplicationError('INVALID_STATE', 409, '对账报告与当前 M05 Run 不一致');
      }
      await client.query('DELETE FROM index_reconciliation_reports WHERE indexing_run_id = $1', [
        indexingRunId,
      ]);
      await client.query(
        `INSERT INTO index_reconciliation_reports (
           indexing_run_id, manifest_id, expected_count, actual_count,
           checked_primary_keys, fixed_queries_passed, issues, passed, report_sha256
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,true,$8)`,
        [
          indexingRunId,
          report.manifestId,
          report.expectedCount,
          report.actualCount,
          report.checkedPrimaryKeys,
          report.fixedQueriesPassed,
          JSON.stringify(report.issues),
          report.reportSha256,
        ],
      );
      await client.query(
        `UPDATE space_manifests SET status = 'VERIFIED', actual_vector_count = $2,
                reconciliation_sha256 = $3, updated_at = now() WHERE id = $1 AND status = 'BUILDING'`,
        [report.manifestId, report.actualCount, report.reportSha256],
      );
      await client.query(
        `UPDATE indexing_runs SET status = 'VERIFIED', updated_at = now() WHERE id = $1`,
        [indexingRunId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Profile 候选只进入 EVALUATING，不修改 space_manifest_heads。
   * Job 完成与请求状态在同一事务提交，Scheduler 不会评测一个仍在写入的 Manifest。
   */
  public async stageProfileCandidate(
    indexingRunId: string,
    jobId: string,
    workerId: string,
    requestId: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, jobId, workerId, 'PUBLISH');
      const result = await client.query<IndexingRunRow>(
        `SELECT run.* FROM indexing_runs run
          JOIN index_rebuild_jobs link ON link.job_id = run.job_id
         WHERE run.id = $1 AND run.job_id = $2 AND link.request_id = $3
         FOR UPDATE OF run`,
        [indexingRunId, jobId, requestId],
      );
      const run = requireRow(result.rows[0], 'Profile 候选 Run 不存在');
      if (run.status !== 'VERIFIED') {
        throw new ApplicationError('INVALID_STATE', 409, '只有 VERIFIED 候选可以进入评测');
      }
      const updated = await client.query(
        `UPDATE index_rebuild_requests request
            SET status = 'EVALUATING', candidate_manifest_id = $2,
                lease_owner = NULL, lease_expires_at = NULL, available_at = now(), updated_at = now()
          WHERE request.id = $1 AND request.pipeline_job_id = $3 AND request.status = 'BUILDING'`,
        [requestId, run.manifest_id, jobId],
      );
      if (updated.rowCount !== 1) {
        throw new ApplicationError('INVALID_STATE', 409, 'Profile 重建请求状态不允许进入评测');
      }
      await this.completeJob(client, jobId, workerId, run.document_version_id);
      await client.query(
        `UPDATE ingestion_jobs SET public_message = 'Profile 候选已验证，等待离线评测' WHERE id = $1`,
        [jobId],
      );
      await this.insertJobEvent(client, jobId, 'ingestion.m05_candidate_staged', {
        requestId,
        indexingRunId,
        manifestId: run.manifest_id,
      });
      await this.insertOutbox(
        client,
        'INDEX_REBUILD',
        requestId,
        'index.profile_evaluation.requested',
        {
          requestId,
          spaceId: run.space_id,
          manifestId: run.manifest_id,
        },
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * IDX-011 原子发布事务：旧 Manifest 降级、新 Manifest 激活、Head、成员、任务状态和 Outbox 同时提交。
   * 事务回滚时 Head 完全不变，因此 Milvus 已写入的新记录仍只是不可见垃圾。
   */
  public async publish(
    indexingRunId: string,
    jobId: string,
    workerId: string,
  ): Promise<PublishManifestResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, jobId, workerId, 'PUBLISH');
      const runResult = await client.query<IndexingRunRow>(
        'SELECT * FROM indexing_runs WHERE id = $1 AND job_id = $2 FOR UPDATE',
        [indexingRunId, jobId],
      );
      const run = requireRow(runResult.rows[0], 'M05 Run 不存在');
      if (run.status !== 'VERIFIED') {
        throw new ApplicationError('INVALID_STATE', 409, '只有 VERIFIED Run 可以发布');
      }
      await client.query('SELECT id FROM knowledge_spaces WHERE id = $1 FOR UPDATE', [
        run.space_id,
      ]);
      const headResult = await client.query<{ active_manifest_id: string }>(
        'SELECT active_manifest_id FROM space_manifest_heads WHERE space_id = $1 FOR UPDATE',
        [run.space_id],
      );
      const supersededManifestId = headResult.rows[0]?.active_manifest_id ?? null;
      if (supersededManifestId) {
        await client.query(
          `UPDATE space_manifests SET status = 'SUPERSEDED', updated_at = now()
            WHERE id = $1 AND status = 'ACTIVE'`,
          [supersededManifestId],
        );
      }
      const activated = await client.query<ManifestRow>(
        `UPDATE space_manifests SET status = 'ACTIVE', activated_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'VERIFIED' RETURNING *`,
        [run.manifest_id],
      );
      const manifestRow = requireRow(activated.rows[0], 'Manifest 发布状态冲突');
      await client.query(
        `INSERT INTO space_manifest_heads (
           space_id, active_manifest_id, active_manifest_version, optimistic_version
         ) VALUES ($1,$2,$3,1)
         ON CONFLICT (space_id) DO UPDATE SET
           active_manifest_id = EXCLUDED.active_manifest_id,
           active_manifest_version = EXCLUDED.active_manifest_version,
           optimistic_version = space_manifest_heads.optimistic_version + 1,
           updated_at = now()`,
        [run.space_id, run.manifest_id, run.manifest_version],
      );
      await client.query(
        `UPDATE indexing_runs SET status = 'PUBLISHED', completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [indexingRunId],
      );
      await this.completeJob(client, jobId, workerId, run.document_version_id);
      await this.insertJobEvent(client, jobId, 'ingestion.m05_published', {
        indexingRunId,
        manifestId: run.manifest_id,
        manifestVersion: run.manifest_version,
      });
      for (const eventType of [
        'index.manifest.published',
        'index.document.membership.changed',
        'cache.invalidate.space',
      ]) {
        await this.insertOutbox(client, 'SPACE_MANIFEST', run.manifest_id, eventType, {
          spaceId: run.space_id,
          manifestId: run.manifest_id,
          manifestVersion: run.manifest_version,
          documentVersionId: run.document_version_id,
        });
      }
      if (supersededManifestId) {
        await client.query(
          `INSERT INTO index_maintenance_tasks (task_type, manifest_id, available_at)
           VALUES ('CLEANUP_MANIFEST',$1,now() + make_interval(days => $2))
           ON CONFLICT (task_type, manifest_id) DO NOTHING`,
          [supersededManifestId, this.retentionDays],
        );
      }
      await client.query(
        `INSERT INTO index_maintenance_tasks (task_type, manifest_id, available_at)
         VALUES ('RECONCILE_MANIFEST',$1,now() + interval '10 minutes')
         ON CONFLICT (task_type, manifest_id) DO NOTHING`,
        [run.manifest_id],
      );
      await client.query('COMMIT');
      return { manifest: mapManifest(manifestRow), supersededManifestId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 失败只关闭本次构建并让任务等待重试；不读取或修改 space_manifest_heads。 */
  public async fail(
    indexingRunId: string | null,
    jobId: string,
    workerId: string,
    failureCode: string,
    publicMessage: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (indexingRunId) {
        await client.query(
          `UPDATE indexing_runs SET status = 'FAILED', failure_code = $2,
                  failure_message = $3, completed_at = now(), updated_at = now()
            WHERE id = $1 AND status <> 'PUBLISHED'`,
          [indexingRunId, failureCode, publicMessage],
        );
        await client.query(
          `UPDATE space_manifests SET status = 'FAILED', updated_at = now()
            WHERE id = (SELECT manifest_id FROM indexing_runs WHERE id = $1)
              AND status IN ('BUILDING','VERIFIED')`,
          [indexingRunId],
        );
      }
      await client.query(
        `UPDATE ingestion_job_steps SET status = 'WAITING', public_message = $3,
                finished_at = now(), updated_at = now()
          WHERE job_id = $1 AND step_name = (
            SELECT current_step FROM ingestion_jobs WHERE id = $1 AND lease_owner = $2
          )`,
        [jobId, workerId, publicMessage],
      );
      await client.query(
        `UPDATE ingestion_jobs SET status = 'WAITING', public_message = $3,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [jobId, workerId, publicMessage],
      );
      await client.query(
        `UPDATE document_versions SET status = 'WAITING', updated_at = now()
          WHERE id = (SELECT document_version_id FROM ingestion_jobs WHERE id = $1)`,
        [jobId],
      );
      await this.insertJobEvent(client, jobId, 'ingestion.m05_failed', {
        indexingRunId,
        failureCode,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 清理失败只更新维护任务告警，不改变 Manifest 可见性。 */
  public async recordCleanupWarning(manifestId: string, publicMessage: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO index_maintenance_tasks (
         task_type, manifest_id, status, attempts, available_at, last_error
       ) VALUES ('CLEANUP_MANIFEST',$1,'WAITING',1,now() + interval '1 hour',$2)
       ON CONFLICT (task_type, manifest_id) DO UPDATE SET
         status = 'WAITING', attempts = index_maintenance_tasks.attempts + 1,
         available_at = now() + interval '1 hour', last_error = EXCLUDED.last_error,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()`,
      [manifestId, publicMessage],
    );
  }

  /** 按受保护资源映射读取 M05 Run。 */
  public async getRun(
    context: AccessContext,
    indexingRunId: string,
  ): Promise<IndexingRun | undefined> {
    await this.assertResourceAccess(context, 'INDEX_RUN', indexingRunId, 'READ');
    const result = await this.pool.query<IndexingRunRow>(
      'SELECT * FROM indexing_runs WHERE id = $1',
      [indexingRunId],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
  }

  /** 对账报告沿用 INDEX_RUN 的受保护空间映射，不向无权限用户泄漏主键差异。 */
  public async getReconciliation(
    context: AccessContext,
    indexingRunId: string,
  ): Promise<IndexReconciliationReport | undefined> {
    await this.assertResourceAccess(context, 'INDEX_RUN', indexingRunId, 'READ');
    const result = await this.pool.query<{
      manifest_id: string;
      expected_count: number;
      actual_count: number;
      checked_primary_keys: number;
      fixed_queries_passed: number;
      issues: unknown;
      passed: boolean;
      report_sha256: string;
    }>('SELECT * FROM index_reconciliation_reports WHERE indexing_run_id = $1', [indexingRunId]);
    const row = result.rows[0];
    if (!row) return undefined;
    return IndexReconciliationReportSchema.parse({
      manifestId: row.manifest_id,
      expectedCount: row.expected_count,
      actualCount: row.actual_count,
      checkedPrimaryKeys: row.checked_primary_keys,
      fixedQueriesPassed: row.fixed_queries_passed,
      issues: row.issues,
      passed: row.passed,
      reportSha256: row.report_sha256,
    });
  }

  /** 空间 Manifest 历史按版本倒序返回；BUILDING 也只对有空间权限的管理端可见。 */
  public async listManifests(
    context: AccessContext,
    spaceId: string,
  ): Promise<readonly SpaceManifest[]> {
    await this.assertSpacePermission(context, spaceId, 'READ');
    const result = await this.pool.query<ManifestRow>(
      'SELECT * FROM space_manifests WHERE space_id = $1 ORDER BY version DESC',
      [spaceId],
    );
    return result.rows.map(mapManifest);
  }

  /** 回滚只切换到保留向量的 VERIFIED/SUPERSEDED Manifest，并可靠发出缓存失效事件。 */
  public async rollback(
    context: AccessContext,
    spaceId: string,
    request: RollbackManifestRequest,
  ): Promise<SpaceManifest> {
    await this.assertSpacePermission(context, spaceId, 'ADMIN');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM knowledge_spaces WHERE id = $1 FOR UPDATE', [spaceId]);
      const targetResult = await client.query<ManifestRow>(
        `SELECT manifest.* FROM space_manifests manifest
          WHERE manifest.space_id = $1 AND manifest.version = $2
            AND manifest.status IN ('SUPERSEDED','VERIFIED','ACTIVE')
            AND NOT EXISTS (
              SELECT 1 FROM index_maintenance_tasks task
               WHERE task.manifest_id = manifest.id AND task.task_type = 'CLEANUP_MANIFEST'
                 AND task.status = 'SUCCEEDED'
            )
          FOR UPDATE`,
        [spaceId, request.targetManifestVersion],
      );
      const target = requireRow(targetResult.rows[0], '目标 Manifest 不存在或向量已清理');
      const head = await client.query<{ active_manifest_id: string }>(
        'SELECT active_manifest_id FROM space_manifest_heads WHERE space_id = $1 FOR UPDATE',
        [spaceId],
      );
      const currentId = head.rows[0]?.active_manifest_id;
      if (currentId && currentId !== target.id) {
        await client.query(
          `UPDATE space_manifests SET status = 'SUPERSEDED', updated_at = now()
            WHERE id = $1 AND status = 'ACTIVE'`,
          [currentId],
        );
        await client.query(
          `UPDATE space_manifests SET status = 'ACTIVE', activated_at = now(), updated_at = now()
            WHERE id = $1`,
          [target.id],
        );
        await client.query(
          `UPDATE space_manifest_heads SET active_manifest_id = $2,
                  active_manifest_version = $3, optimistic_version = optimistic_version + 1,
                  updated_at = now() WHERE space_id = $1`,
          [spaceId, target.id, target.version],
        );
      }
      for (const eventType of ['index.manifest.rolled_back', 'cache.invalidate.space']) {
        await this.insertOutbox(
          client,
          'SPACE_MANIFEST_ROLLBACK',
          `${target.id}:${context.requestId}`,
          eventType,
          {
            spaceId,
            previousManifestId: currentId ?? null,
            activeManifestId: target.id,
            activeManifestVersion: target.version,
          },
        );
      }
      await this.insertAudit(
        client,
        context,
        'INDEX_MANIFEST_ROLLBACK',
        'SPACE_MANIFEST',
        target.id,
        request.reason,
        {
          spaceId,
          previousManifestId: currentId ?? null,
          targetManifestVersion: target.version,
        },
      );
      await client.query('COMMIT');
      return mapManifest({ ...target, status: 'ACTIVE', activated_at: new Date() });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 创建可审计的全量/灰度重建请求并通过 Outbox 触发自动化执行。 */
  public async enqueueProfileRebuild(
    context: AccessContext,
    spaceId: string,
    embeddingProfileId: string,
    mode: 'FULL' | 'CANARY',
    canaryPercent: number,
    reason: string,
  ): Promise<string> {
    await this.assertSpacePermission(context, spaceId, 'ADMIN');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 新 Profile 在 rollout worker 启动时才写 Registry；API 只保存不可执行的声明，
      // Scheduler 会将其与当前进程的完整不可变 Profile 精确比对后才创建重建 Job。
      const result = await client.query<{ id: string }>(
        `INSERT INTO index_rebuild_requests (
           space_id, embedding_profile_id, mode, canary_percent, reason,
           requested_by, requested_roles
         ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          spaceId,
          embeddingProfileId,
          mode,
          canaryPercent,
          reason,
          context.user.userId,
          [...context.user.roles],
        ],
      );
      const id = requireRow(result.rows[0], '重建请求创建失败').id;
      await this.insertOutbox(client, 'INDEX_REBUILD', id, 'index.profile_rebuild.requested', {
        requestId: id,
        spaceId,
        embeddingProfileId,
        mode,
        canaryPercent,
      });
      await this.insertAudit(
        client,
        context,
        'INDEX_PROFILE_REBUILD_REQUEST',
        'KNOWLEDGE_SPACE',
        spaceId,
        reason,
        {
          requestId: id,
          embeddingProfileId,
          mode,
          canaryPercent,
        },
      );
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 读取单个 rollout；无空间权限时沿用 404 防枚举语义。 */
  public async getProfileRebuild(
    context: AccessContext,
    spaceId: string,
    requestId: string,
  ): Promise<IndexRebuild | undefined> {
    await this.assertSpacePermission(context, spaceId, 'READ');
    const result = await this.pool.query<RebuildRow>(
      `SELECT * FROM index_rebuild_requests WHERE id = $1 AND space_id = $2`,
      [requestId, spaceId],
    );
    return result.rows[0] ? mapRebuild(result.rows[0]) : undefined;
  }

  /** 领取 QUEUED 构建或 EVALUATING 评测动作；过期 lease 可被其他 Scheduler 接管。 */
  public async claimProfileRebuildTasks(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly ProfileRebuildTask[]> {
    const result = await this.pool.query<RebuildRow>(
      `WITH candidates AS (
         SELECT id FROM index_rebuild_requests
          WHERE status IN ('QUEUED','EVALUATING') AND available_at <= now()
            AND (lease_expires_at IS NULL OR lease_expires_at <= now())
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE index_rebuild_requests request
          SET lease_owner = $1, lease_expires_at = now() + make_interval(secs => $3),
              attempts = attempts + 1, updated_at = now()
         FROM candidates WHERE request.id = candidates.id
       RETURNING request.*`,
      [workerId, limit, leaseSeconds],
    );
    return result.rows.map((row) => ({
      requestId: row.id,
      action: row.status === 'QUEUED' ? 'BUILD' : 'EVALUATE',
      spaceId: row.space_id,
      embeddingProfileId: row.embedding_profile_id,
      mode: row.mode,
      canaryPercent: row.canary_percent,
      attempts: row.attempts,
    }));
  }

  /**
   * 选择稳定 Manifest 的一个代表文档创建新 contentRevision Job。
   * M05 构建 Manifest 时会复制稳定版本的全部成员，因此一次 Job 即可对全空间用新 Profile 重建。
   */
  public async prepareProfileRebuild(
    requestId: string,
    workerId: string,
    profile: EmbeddingProfile,
  ): Promise<string> {
    await this.resolveProfileCollection(profile);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const requestResult = await client.query<RebuildRow>(
        `SELECT * FROM index_rebuild_requests
          WHERE id = $1 AND status = 'QUEUED' AND lease_owner = $2
            AND lease_expires_at > now() FOR UPDATE`,
        [requestId, workerId],
      );
      const request = requireRow(requestResult.rows[0], 'Profile 重建 lease 已失效');
      if (request.embedding_profile_id !== profile.profileId) {
        throw new ApplicationError(
          'PROVIDER_PROFILE_MISMATCH',
          409,
          '重建请求 Profile 与当前 rollout worker 配置不一致',
        );
      }
      const memberResult = await client.query<{
        stable_manifest_id: string;
        document_id: string;
        document_version_id: string;
        content_revision: number;
      }>(
        `SELECT head.active_manifest_id AS stable_manifest_id, member.document_id,
                member.document_version_id, member.content_revision
           FROM space_manifest_heads head
           JOIN manifest_document_members member ON member.manifest_id = head.active_manifest_id
          WHERE head.space_id = $1
          ORDER BY member.document_id LIMIT 1 FOR UPDATE OF head`,
        [request.space_id],
      );
      const member = requireRow(memberResult.rows[0], '空间没有可用于 Profile 重建的已发布文档');
      const revisionResult = await client.query<{ content_revision: number }>(
        `UPDATE document_versions
            SET content_revision = content_revision + 1, status = 'QUEUED',
                optimistic_version = optimistic_version + 1, updated_at = now()
          WHERE id = $1 AND content_revision = $2
          RETURNING content_revision`,
        [member.document_version_id, member.content_revision],
      );
      const contentRevision = requireRow(
        revisionResult.rows[0],
        '代表文档已被其他任务修改，请稍后重试',
      ).content_revision;
      const pipelineResult = await client.query<{ pipeline_version: number }>(
        `SELECT COALESCE(MAX(pipeline_version),0)::int + 1 AS pipeline_version
           FROM ingestion_jobs WHERE document_version_id = $1`,
        [member.document_version_id],
      );
      const pipelineVersion = requireRow(
        pipelineResult.rows[0],
        'pipeline version 生成失败',
      ).pipeline_version;
      const jobId = `profile-rebuild:${requestId}`;
      await client.query(
        `INSERT INTO ingestion_jobs (
           id, document_id, document_version_id, content_revision, pipeline_version,
           status, current_step, overall_percent, public_message
         ) VALUES ($1,$2,$3,$4,$5,'QUEUED','SECURITY_SCAN',0,'Profile 全空间重建已排队')`,
        [jobId, member.document_id, member.document_version_id, contentRevision, pipelineVersion],
      );
      for (const [position, step] of INGESTION_STEP_ORDER.entries()) {
        await client.query(
          `INSERT INTO ingestion_job_steps (
             id, job_id, step_name, step_version, position, status, weight_percent,
             processed_units, overall_percent, public_message
           ) VALUES ($1,$2,$3,1,$4,'QUEUED',$5,0,0,'等待执行')`,
          [`${jobId}:${step}:v1`, jobId, step, position + 1, INGESTION_STEP_WEIGHTS[step]],
        );
      }
      await client.query(`INSERT INTO index_rebuild_jobs (request_id, job_id) VALUES ($1,$2)`, [
        requestId,
        jobId,
      ]);
      await client.query(
        `UPDATE index_rebuild_requests
            SET status = 'BUILDING', previous_manifest_id = $2, pipeline_job_id = $3,
                lease_owner = NULL, lease_expires_at = NULL, failure_code = NULL,
                failure_message = NULL, updated_at = now()
          WHERE id = $1`,
        [requestId, member.stable_manifest_id, jobId],
      );
      await this.insertOutbox(client, 'INGESTION_JOB', jobId, 'ingestion.requested', {
        jobId,
        spaceId: request.space_id,
        documentVersionId: member.document_version_id,
        contentRevision,
        pipelineVersion,
        profileRebuildRequestId: requestId,
      });
      await client.query('COMMIT');
      return jobId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 加载候选 Manifest 和每个文档的代表查询；不把查询正文写入评测报告。 */
  public async loadProfileCandidate(
    requestId: string,
    workerId: string,
    maxCases: number,
  ): Promise<ProfileCandidateSnapshot> {
    const requestResult = await this.pool.query<RebuildRow>(
      `SELECT * FROM index_rebuild_requests
        WHERE id = $1 AND status = 'EVALUATING' AND lease_owner = $2
          AND lease_expires_at > now()`,
      [requestId, workerId],
    );
    const request = requireRow(requestResult.rows[0], 'Profile 评测 lease 已失效');
    const manifestResult = await this.pool.query<ManifestRow>(
      `SELECT * FROM space_manifests WHERE id = $1 AND status = 'VERIFIED'`,
      [request.candidate_manifest_id],
    );
    const manifest = mapManifest(
      requireRow(manifestResult.rows[0], 'VERIFIED 候选 Manifest 不存在'),
    );
    const cases = await this.pool.query<{
      chunk_id: string;
      embedding_text: string;
      content_sha256: string;
      token_count: number;
      document_id: string;
    }>(
      `SELECT DISTINCT ON (member.document_id)
              chunk.id AS chunk_id, chunk.embedding_text, chunk.content_sha256::text,
              chunk.token_count, member.document_id
         FROM manifest_document_members member
         JOIN knowledge_chunks chunk
           ON chunk.document_version_id = member.document_version_id
          AND chunk.content_revision = member.content_revision
        WHERE member.manifest_id = $1 AND chunk.granularity = 'CHILD'
          AND chunk.eligible_for_index = true
        ORDER BY member.document_id, chunk.ordinal
        LIMIT $2`,
      [manifest.id, maxCases],
    );
    if (cases.rows.length === 0) throw new Error('Profile 离线评测没有可用代表样本');
    return {
      requestId,
      manifest,
      cases: cases.rows.map((row) => ({
        caseId: row.chunk_id,
        queryText: row.embedding_text,
        querySha256: row.content_sha256,
        tokenCount: row.token_count,
        expectedDocumentId: row.document_id,
      })),
    };
  }

  /** 评测通过后 FULL 原子切 Head，CANARY 仅登记灰度指针；失败候选永不在线。 */
  public async completeProfileEvaluation(
    requestId: string,
    workerId: string,
    report: Record<string, unknown>,
    passed: boolean,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const requestResult = await client.query<RebuildRow>(
        `SELECT * FROM index_rebuild_requests
          WHERE id = $1 AND status = 'EVALUATING' AND lease_owner = $2
            AND lease_expires_at > now() FOR UPDATE`,
        [requestId, workerId],
      );
      const request = requireRow(requestResult.rows[0], 'Profile 评测提交 lease 已失效');
      if (!passed) {
        await client.query(
          `UPDATE index_rebuild_requests
              SET status = 'FAILED', evaluation_report = $2::jsonb,
                  failure_code = 'OFFLINE_EVALUATION_FAILED',
                  failure_message = 'Profile 候选离线评测未通过', completed_at = now(),
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1`,
          [requestId, JSON.stringify(report)],
        );
        await client.query(
          `UPDATE space_manifests SET status = 'FAILED', updated_at = now()
            WHERE id = $1 AND status = 'VERIFIED'`,
          [request.candidate_manifest_id],
        );
        await client.query(
          `INSERT INTO index_maintenance_tasks (task_type, manifest_id, available_at)
           VALUES ('CLEANUP_MANIFEST',$1,now()) ON CONFLICT DO NOTHING`,
          [request.candidate_manifest_id],
        );
        await this.insertOutbox(
          client,
          'INDEX_REBUILD',
          requestId,
          'index.profile_evaluation.failed',
          {
            requestId,
            spaceId: request.space_id,
            candidateManifestId: request.candidate_manifest_id,
          },
        );
      } else if (request.mode === 'CANARY') {
        if (request.canary_percent >= 100) throw new Error('CANARY 比例必须小于 100');
        await client.query(
          `INSERT INTO space_manifest_canaries (
             space_id, rebuild_request_id, stable_manifest_id,
             candidate_manifest_id, canary_percent
           ) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (space_id) DO UPDATE SET
             rebuild_request_id = EXCLUDED.rebuild_request_id,
             stable_manifest_id = EXCLUDED.stable_manifest_id,
             candidate_manifest_id = EXCLUDED.candidate_manifest_id,
             canary_percent = EXCLUDED.canary_percent, routing_salt = gen_random_uuid(),
             updated_at = now()`,
          [
            request.space_id,
            requestId,
            request.previous_manifest_id,
            request.candidate_manifest_id,
            request.canary_percent,
          ],
        );
        await client.query(
          `UPDATE index_rebuild_requests SET status = 'READY', evaluation_report = $2::jsonb,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = $1`,
          [requestId, JSON.stringify(report)],
        );
        for (const eventType of ['index.profile_canary.ready', 'cache.invalidate.space']) {
          await this.insertOutbox(client, 'INDEX_REBUILD', requestId, eventType, {
            requestId,
            spaceId: request.space_id,
            stableManifestId: request.previous_manifest_id,
            candidateManifestId: request.candidate_manifest_id,
            canaryPercent: request.canary_percent,
          });
        }
      } else {
        await this.activateRolloutCandidate(
          client,
          request,
          report,
          'index.profile_rebuild.published',
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 可重试错误释放 lease；终态错误同时封闭候选并安排异步垃圾清理。 */
  public async failProfileRebuild(
    requestId: string,
    workerId: string,
    failureCode: string,
    publicMessage: string,
    retryDelaySeconds: number,
    terminal: boolean,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ candidate_manifest_id: string | null }>(
        `UPDATE index_rebuild_requests
            SET status = CASE WHEN $3 THEN 'FAILED' ELSE status END,
                available_at = now() + make_interval(secs => $4), failure_code = $5,
                failure_message = left($6,500), completed_at = CASE WHEN $3 THEN now() ELSE NULL END,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2
          RETURNING candidate_manifest_id`,
        [requestId, workerId, terminal, retryDelaySeconds, failureCode, publicMessage],
      );
      const row = requireRow(result.rows[0], 'Profile 重建失败提交 lease 已失效');
      if (terminal && row.candidate_manifest_id) {
        await client.query(
          `UPDATE space_manifests SET status = 'FAILED', updated_at = now()
            WHERE id = $1 AND status IN ('BUILDING','VERIFIED')`,
          [row.candidate_manifest_id],
        );
        await client.query(
          `INSERT INTO index_maintenance_tasks (task_type, manifest_id, available_at)
           VALUES ('CLEANUP_MANIFEST',$1,now()) ON CONFLICT DO NOTHING`,
          [row.candidate_manifest_id],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** CANARY 观察完成后一键提升候选；若稳定 Head 已变化则拒绝覆盖并要求重新构建。 */
  public async promoteProfileRebuild(
    context: AccessContext,
    spaceId: string,
    requestId: string,
    reason: string,
  ): Promise<SpaceManifest> {
    await this.assertSpacePermission(context, spaceId, 'ADMIN');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<RebuildRow>(
        `SELECT * FROM index_rebuild_requests
          WHERE id = $1 AND space_id = $2 AND status = 'READY' FOR UPDATE`,
        [requestId, spaceId],
      );
      const request = requireRow(result.rows[0], '只有 READY 灰度请求可以提升');
      await this.activateRolloutCandidate(
        client,
        request,
        asJsonRecord(request.evaluation_report),
        'index.profile_canary.promoted',
      );
      await this.insertAudit(
        client,
        context,
        'INDEX_PROFILE_CANARY_PROMOTE',
        'SPACE_MANIFEST',
        requireValue(request.candidate_manifest_id, '候选 Manifest 缺失'),
        reason,
        { requestId, spaceId, previousManifestId: request.previous_manifest_id },
      );
      const manifestResult = await client.query<ManifestRow>(
        `SELECT * FROM space_manifests WHERE id = $1`,
        [request.candidate_manifest_id],
      );
      await client.query('COMMIT');
      return mapManifest(requireRow(manifestResult.rows[0], '提升后的 Manifest 不存在'));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 请求级一键回退：READY 取消灰度；PUBLISHED 切回请求开始时的稳定 Manifest。 */
  public async rollbackProfileRebuild(
    context: AccessContext,
    spaceId: string,
    requestId: string,
    reason: string,
  ): Promise<SpaceManifest> {
    await this.assertSpacePermission(context, spaceId, 'ADMIN');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<RebuildRow>(
        `SELECT * FROM index_rebuild_requests
          WHERE id = $1 AND space_id = $2 AND status IN ('READY','PUBLISHED') FOR UPDATE`,
        [requestId, spaceId],
      );
      const request = requireRow(result.rows[0], 'Profile 重建请求当前不可回退');
      const previousManifestId = requireValue(
        request.previous_manifest_id,
        '历史稳定 Manifest 缺失',
      );
      const candidateManifestId = requireValue(request.candidate_manifest_id, '候选 Manifest 缺失');
      await client.query('SELECT id FROM knowledge_spaces WHERE id = $1 FOR UPDATE', [spaceId]);
      let activeManifestId = previousManifestId;
      if (request.status === 'READY') {
        await client.query('DELETE FROM space_manifest_canaries WHERE rebuild_request_id = $1', [
          requestId,
        ]);
        await client.query(
          `UPDATE space_manifests SET status = 'REVOKED', updated_at = now()
            WHERE id = $1 AND status = 'VERIFIED'`,
          [candidateManifestId],
        );
      } else {
        const head = await client.query<{ active_manifest_id: string }>(
          `SELECT active_manifest_id FROM space_manifest_heads WHERE space_id = $1 FOR UPDATE`,
          [spaceId],
        );
        if (head.rows[0]?.active_manifest_id !== candidateManifestId) {
          throw new ApplicationError('VERSION_CONFLICT', 409, '稳定 Head 已变化，禁止覆盖式回退');
        }
        const previous = await client.query<ManifestRow>(
          `SELECT * FROM space_manifests
            WHERE id = $1 AND space_id = $2 AND status = 'SUPERSEDED' FOR UPDATE`,
          [previousManifestId, spaceId],
        );
        const previousRow = requireRow(previous.rows[0], '历史 Manifest 已不可回退');
        await client.query(
          `UPDATE space_manifests SET status = 'SUPERSEDED', updated_at = now()
            WHERE id = $1 AND status = 'ACTIVE'`,
          [candidateManifestId],
        );
        await client.query(
          `UPDATE space_manifests SET status = 'ACTIVE', activated_at = now(), updated_at = now()
            WHERE id = $1`,
          [previousManifestId],
        );
        await client.query(
          `UPDATE space_manifest_heads SET active_manifest_id = $2,
                  active_manifest_version = $3, optimistic_version = optimistic_version + 1,
                  updated_at = now() WHERE space_id = $1`,
          [spaceId, previousManifestId, previousRow.version],
        );
        activeManifestId = previousRow.id;
      }
      await client.query(
        `UPDATE index_rebuild_requests SET status = 'ROLLED_BACK', completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [requestId],
      );
      await client.query(
        `INSERT INTO index_maintenance_tasks (task_type, manifest_id, available_at)
         VALUES ('CLEANUP_MANIFEST',$1,now() + make_interval(days => $2))
         ON CONFLICT DO NOTHING`,
        [candidateManifestId, this.retentionDays],
      );
      for (const eventType of ['index.profile_rebuild.rolled_back', 'cache.invalidate.space']) {
        await this.insertOutbox(client, 'INDEX_REBUILD', `${requestId}:rollback`, eventType, {
          requestId,
          spaceId,
          candidateManifestId,
          activeManifestId,
        });
      }
      await this.insertAudit(
        client,
        context,
        'INDEX_PROFILE_REBUILD_ROLLBACK',
        'SPACE_MANIFEST',
        activeManifestId,
        reason,
        { requestId, spaceId, candidateManifestId },
      );
      const active = await client.query<ManifestRow>(
        'SELECT * FROM space_manifests WHERE id = $1',
        [activeManifestId],
      );
      await client.query('COMMIT');
      return mapManifest(requireRow(active.rows[0], '回退后的 Manifest 不存在'));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 使用 SKIP LOCKED 有限领取维护任务；过期 lease 可以由其他 Scheduler 恢复。 */
  public async claimMaintenanceTasks(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly IndexMaintenanceTask[]> {
    const result = await this.pool.query<{
      id: string;
      task_type: IndexMaintenanceTask['taskType'];
      manifest_id: string;
      attempts: number;
      collection_name: string;
      manifest_status: SpaceManifest['status'];
    }>(
      `WITH candidates AS (
         SELECT id FROM index_maintenance_tasks
          WHERE (
            (status IN ('QUEUED','WAITING') AND available_at <= now())
            OR (status = 'RUNNING' AND lease_expires_at <= now())
          )
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED LIMIT $2
       ), claimed AS (
         UPDATE index_maintenance_tasks task
            SET status = 'RUNNING', attempts = attempts + 1, lease_owner = $1,
                lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
           FROM candidates WHERE task.id = candidates.id
         RETURNING task.*
       )
       SELECT claimed.id, claimed.task_type, claimed.manifest_id, claimed.attempts,
              manifest.collection_name, manifest.status AS manifest_status
         FROM claimed JOIN space_manifests manifest ON manifest.id = claimed.manifest_id`,
      [workerId, limit, leaseSeconds],
    );
    return result.rows.map((row) => ({
      id: row.id,
      taskType: row.task_type,
      manifestId: row.manifest_id,
      collectionName: row.collection_name,
      manifestStatus: row.manifest_status,
      attempts: row.attempts,
    }));
  }

  /** 从 PG 事实和已持久化 Embedding 中重建期望 Milvus 行，不重新调用模型。 */
  public async loadMaintenanceSnapshot(manifestId: string): Promise<IndexMaintenanceSnapshot> {
    const manifestResult = await this.pool.query<ManifestRow>(
      'SELECT * FROM space_manifests WHERE id = $1',
      [manifestId],
    );
    const manifest = mapManifest(requireRow(manifestResult.rows[0], '维护 Manifest 不存在'));
    const result = await this.pool.query<
      ChunkRow & {
        space_id: string;
        embedding_profile_id: string;
        dense_vector: unknown;
        sparse_vector: unknown;
      }
    >(
      `SELECT chunk.id AS chunk_id, document.id AS document_id, manifest.space_id,
              chunk.document_version_id, chunk.content_revision, chunk.ordinal,
              chunk.embedding_text, chunk.display_content, chunk.token_count,
              chunk.content_sha256::text, chunk.heading_path, chunk.source_locations,
              fact.embedding_profile_id, fact.dense_vector, fact.sparse_vector
         FROM chunk_embedding_refs reference
         JOIN space_manifests manifest ON manifest.id = reference.manifest_id
         JOIN knowledge_chunks chunk ON chunk.id = reference.chunk_id
         JOIN document_versions version ON version.id = chunk.document_version_id
         JOIN documents document ON document.id = version.document_id
         JOIN embedding_facts fact ON fact.id = reference.embedding_fact_id
        WHERE reference.manifest_id = $1
        ORDER BY document.id, chunk.ordinal`,
      [manifestId],
    );
    const records: IndexVectorRecord[] = result.rows.map((row) => ({
      vectorId: createHash('sha256')
        .update(`${manifest.id}:${row.chunk_id}:${manifest.embeddingProfileId}`)
        .digest('hex'),
      manifestId: manifest.id,
      spaceId: row.space_id,
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      contentRevision: row.content_revision,
      chunkId: row.chunk_id,
      ordinal: row.ordinal,
      contentSha256: row.content_sha256,
      embeddingProfileId: row.embedding_profile_id,
      shortSummary: row.display_content.replace(/\s+/g, ' ').trim().slice(0, 500),
      headingPath: Array.isArray(row.heading_path)
        ? row.heading_path.filter((item): item is string => typeof item === 'string')
        : [],
      sourceLocations: Array.isArray(row.source_locations) ? row.source_locations : [],
      dense: parseDense(row.dense_vector),
      sparse: parseSparse(row.sparse_vector),
    }));
    const sources = await this.pool.query<{
      bucket: string;
      object_key: string;
      sha256: string | null;
    }>(
      `SELECT DISTINCT file.bucket, file.object_key, file.sha256::text
         FROM manifest_document_members member
         JOIN document_files file ON file.document_version_id = member.document_version_id
        WHERE member.manifest_id = $1`,
      [manifestId],
    );
    return {
      manifest,
      records,
      sourceObjects: sources.rows.map((row) => ({
        bucket: row.bucket,
        objectKey: row.object_key,
        sha256: row.sha256,
      })),
    };
  }

  /** 对账任务成功后定时再排队；清理任务则进入终态 SUCCEEDED。 */
  public async completeMaintenanceTask(
    taskId: string,
    workerId: string,
    result: Record<string, unknown>,
    nextRunAt: Date | null,
  ): Promise<void> {
    const updated = await this.pool.query(
      `UPDATE index_maintenance_tasks SET status = CASE WHEN $3::timestamptz IS NULL
                THEN 'SUCCEEDED' ELSE 'WAITING' END,
              available_at = COALESCE($3, available_at), last_result = $4::jsonb,
              last_error = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'RUNNING'`,
      [taskId, workerId, nextRunAt, JSON.stringify(result)],
    );
    if (updated.rowCount !== 1)
      throw new ApplicationError('INVALID_STATE', 409, '维护任务 lease 已失效');
  }

  /** 可重试失败回到 WAITING；超过安全次数或不一致不可自动修复时进入 FAILED 人工处理。 */
  public async releaseMaintenanceTask(
    taskId: string,
    workerId: string,
    publicMessage: string,
    retryDelaySeconds: number,
    terminal: boolean,
  ): Promise<void> {
    const updated = await this.pool.query(
      `UPDATE index_maintenance_tasks SET status = CASE WHEN $3 THEN 'FAILED' ELSE 'WAITING' END,
              available_at = now() + make_interval(secs => $4), last_error = left($5,500),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND lease_owner = $2 AND status = 'RUNNING'`,
      [taskId, workerId, terminal, retryDelaySeconds, publicMessage],
    );
    if (updated.rowCount !== 1)
      throw new ApplicationError('INVALID_STATE', 409, '维护任务 lease 已失效');
  }

  /** 在调用方事务内执行 Profile 候选的唯一稳定发布路径。 */
  private async activateRolloutCandidate(
    client: PoolClient,
    request: RebuildRow,
    evaluationReport: Record<string, unknown>,
    eventType: string,
  ): Promise<void> {
    const candidateManifestId = requireValue(request.candidate_manifest_id, '候选 Manifest 缺失');
    const previousManifestId = requireValue(request.previous_manifest_id, '稳定 Manifest 缺失');
    await client.query('SELECT id FROM knowledge_spaces WHERE id = $1 FOR UPDATE', [
      request.space_id,
    ]);
    const head = await client.query<{ active_manifest_id: string }>(
      `SELECT active_manifest_id FROM space_manifest_heads WHERE space_id = $1 FOR UPDATE`,
      [request.space_id],
    );
    if (head.rows[0]?.active_manifest_id !== previousManifestId) {
      throw new ApplicationError(
        'VERSION_CONFLICT',
        409,
        '稳定 Head 已变化，候选必须基于新版本重新构建',
      );
    }
    const candidate = await client.query<ManifestRow>(
      `SELECT * FROM space_manifests
        WHERE id = $1 AND space_id = $2 AND status = 'VERIFIED' FOR UPDATE`,
      [candidateManifestId, request.space_id],
    );
    const candidateRow = requireRow(candidate.rows[0], 'VERIFIED 候选 Manifest 不存在');
    await client.query(
      `UPDATE space_manifests SET status = 'SUPERSEDED', updated_at = now()
        WHERE id = $1 AND status = 'ACTIVE'`,
      [previousManifestId],
    );
    await client.query(
      `UPDATE space_manifests SET status = 'ACTIVE', activated_at = now(), updated_at = now()
        WHERE id = $1`,
      [candidateManifestId],
    );
    await client.query(
      `UPDATE space_manifest_heads SET active_manifest_id = $2,
              active_manifest_version = $3, optimistic_version = optimistic_version + 1,
              updated_at = now() WHERE space_id = $1`,
      [request.space_id, candidateManifestId, candidateRow.version],
    );
    await client.query('DELETE FROM space_manifest_canaries WHERE rebuild_request_id = $1', [
      request.id,
    ]);
    await client.query(
      `UPDATE index_rebuild_requests
          SET status = 'PUBLISHED', evaluation_report = $2::jsonb, completed_at = now(),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1`,
      [request.id, JSON.stringify(evaluationReport)],
    );
    await client.query(
      `INSERT INTO index_maintenance_tasks (task_type, manifest_id, available_at)
       VALUES ('CLEANUP_MANIFEST',$1,now() + make_interval(days => $2))
       ON CONFLICT DO NOTHING`,
      [previousManifestId, this.retentionDays],
    );
    await client.query(
      `INSERT INTO index_maintenance_tasks (task_type, manifest_id, available_at)
       VALUES ('RECONCILE_MANIFEST',$1,now() + interval '10 minutes')
       ON CONFLICT DO NOTHING`,
      [candidateManifestId],
    );
    for (const currentEventType of [eventType, 'cache.invalidate.space']) {
      await this.insertOutbox(client, 'INDEX_REBUILD', `${request.id}:activate`, currentEventType, {
        requestId: request.id,
        spaceId: request.space_id,
        previousManifestId,
        activeManifestId: candidateManifestId,
        activeManifestVersion: candidateRow.version,
      });
    }
  }

  private async loadTargetForUpdate(
    client: PoolClient,
    jobId: string,
    workerId: string,
  ): Promise<
    | {
        space_id: string;
        document_id: string;
        document_version_id: string;
        content_revision: number;
      }
    | undefined
  > {
    const result = await client.query<{
      space_id: string;
      document_id: string;
      document_version_id: string;
      content_revision: number;
    }>(
      `SELECT d.space_id, j.document_id, j.document_version_id, j.content_revision
         FROM ingestion_jobs j
         JOIN documents d ON d.id = j.document_id
         JOIN knowledge_processing_runs processing ON processing.job_id = j.id
         JOIN document_quality_reports quality ON quality.processing_run_id = processing.id
        WHERE j.id = $1 AND j.status = 'RUNNING' AND j.current_step = 'EMBED'
          AND j.lease_owner = $2 AND j.lease_expires_at > now()
          AND processing.status = 'SUCCEEDED' AND quality.eligible_for_index = true
        FOR UPDATE OF j`,
      [jobId, workerId],
    );
    return result.rows[0];
  }

  private async loadBuildInput(indexingRunId: string): Promise<IndexBuildInput> {
    const runResult = await this.pool.query<IndexingRunRow>(
      'SELECT * FROM indexing_runs WHERE id = $1',
      [indexingRunId],
    );
    const runRow = requireRow(runResult.rows[0], 'M05 Run 快照不存在');
    const manifestResult = await this.pool.query<ManifestRow>(
      'SELECT * FROM space_manifests WHERE id = $1',
      [runRow.manifest_id],
    );
    const memberResult = await this.pool.query<MemberRow>(
      'SELECT * FROM manifest_document_members WHERE manifest_id = $1 ORDER BY document_id',
      [runRow.manifest_id],
    );
    const chunkResult = await this.pool.query<ChunkRow>(
      `SELECT chunk.id AS chunk_id, document.id AS document_id,
              chunk.document_version_id, chunk.content_revision, chunk.ordinal,
              chunk.embedding_text, chunk.display_content, chunk.token_count,
              chunk.content_sha256::text, chunk.heading_path, chunk.source_locations
         FROM manifest_document_members member
         JOIN documents document ON document.id = member.document_id
         JOIN knowledge_chunks chunk
           ON chunk.document_version_id = member.document_version_id
          AND chunk.content_revision = member.content_revision
        WHERE member.manifest_id = $1 AND chunk.granularity = 'CHILD'
          AND chunk.eligible_for_index = true
        ORDER BY member.document_id, chunk.ordinal`,
      [runRow.manifest_id],
    );
    const rolloutResult = await this.pool.query<{
      request_id: string;
      mode: 'FULL' | 'CANARY';
      canary_percent: number;
    }>(
      `SELECT link.request_id, request.mode, request.canary_percent
         FROM index_rebuild_jobs link
         JOIN index_rebuild_requests request ON request.id = link.request_id
        WHERE link.job_id = $1`,
      [runRow.job_id],
    );
    const rollout = rolloutResult.rows[0];
    return {
      run: mapRun(runRow),
      manifest: mapManifest(requireRow(manifestResult.rows[0], 'Manifest 快照不存在')),
      members: memberResult.rows.map(mapMember),
      chunks: chunkResult.rows.map(mapChunk),
      ...(rollout
        ? {
            rollout: {
              requestId: rollout.request_id,
              mode: rollout.mode,
              canaryPercent: rollout.canary_percent,
            },
          }
        : {}),
    };
  }

  private async assertLease(
    client: PoolClient,
    jobId: string,
    workerId: string,
    currentStep?: 'PUBLISH',
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM ingestion_jobs WHERE id = $1 AND status = 'RUNNING'
        AND lease_owner = $2 AND lease_expires_at > now()
        AND ($3::text IS NULL OR current_step::text = $3::text) FOR UPDATE`,
      [jobId, workerId, currentStep ?? null],
    );
    if (result.rowCount !== 1) {
      throw new ApplicationError('INVALID_STATE', 409, 'Worker 租约已失效，禁止提交 M05 结果');
    }
  }

  private async completeJob(
    client: PoolClient,
    jobId: string,
    workerId: string,
    documentVersionId: string,
  ): Promise<void> {
    const percentages: Readonly<Record<'EMBED' | 'INDEX' | 'VERIFY' | 'PUBLISH', number>> = {
      EMBED: 87,
      INDEX: 95,
      VERIFY: 98,
      PUBLISH: 100,
    };
    for (const step of ['EMBED', 'INDEX', 'VERIFY', 'PUBLISH'] as const) {
      await client.query(
        `UPDATE ingestion_job_steps SET status = 'SUCCEEDED',
                processed_units = COALESCE(total_units, GREATEST(processed_units,1)),
                total_units = COALESCE(total_units, GREATEST(processed_units,1)),
                stage_percent = 100, overall_percent = $3, public_message = $4,
                finished_at = COALESCE(finished_at,now()), updated_at = now()
          WHERE job_id = $1 AND step_name = $2`,
        [jobId, step, percentages[step], step === 'PUBLISH' ? '知识已原子发布' : `${step} 已完成`],
      );
    }
    await client.query(
      `UPDATE ingestion_jobs SET status = 'SUCCEEDED', current_step = 'PUBLISH',
              overall_percent = 100, public_message = '知识已发布',
              lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND lease_owner = $2`,
      [jobId, workerId],
    );
    await client.query(
      `UPDATE document_versions SET status = 'SUCCEEDED', optimistic_version = optimistic_version + 1,
              updated_at = now() WHERE id = $1`,
      [documentVersionId],
    );
  }

  private async assertResourceAccess(
    context: AccessContext,
    resourceType: 'INDEX_RUN',
    resourceId: string,
    permission: 'READ',
  ): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM protected_resource_spaces protected
         JOIN resource_acl acl ON acl.resource_id = protected.space_id
        WHERE protected.resource_type = $1 AND protected.resource_id = $2
          AND ($3::boolean OR (
            ((acl.subject_type = 'USER' AND acl.subject_id = $4)
              OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($5::text[])))
            AND acl.permissions && ARRAY[$6,'WRITE','REVIEW','ADMIN']::text[]
          )) LIMIT 1`,
      [
        resourceType,
        resourceId,
        context.user.roles.includes('SYSTEM_ADMIN'),
        context.user.userId,
        [...context.user.roles],
        permission,
      ],
    );
    if (result.rowCount !== 1) throw new ApplicationError('NOT_FOUND', 404, 'M05 资源不存在');
  }

  private async assertSpacePermission(
    context: AccessContext,
    spaceId: string,
    permission: 'READ' | 'ADMIN',
  ): Promise<void> {
    const allowed = permission === 'ADMIN' ? ['ADMIN'] : ['READ', 'WRITE', 'REVIEW', 'ADMIN'];
    const result = await this.pool.query(
      `SELECT 1 FROM knowledge_spaces space
        WHERE space.id = $1 AND ($2::boolean OR EXISTS (
          SELECT 1 FROM resource_acl acl WHERE acl.resource_id = space.id
            AND ((acl.subject_type = 'USER' AND acl.subject_id = $3)
              OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($4::text[])))
            AND acl.permissions && $5::text[]
        ))`,
      [
        spaceId,
        context.user.roles.includes('SYSTEM_ADMIN'),
        context.user.userId,
        [...context.user.roles],
        allowed,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ApplicationError(
        permission === 'READ' ? 'NOT_FOUND' : 'ACCESS_DENIED',
        permission === 'READ' ? 404 : 403,
        '无权访问该空间索引',
      );
    }
  }

  private async insertJobEvent(
    client: PoolClient,
    jobId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      'INSERT INTO ingestion_job_events (job_id, event_type, data) VALUES ($1,$2,$3::jsonb)',
      [jobId, eventType, JSON.stringify(data)],
    );
  }

  private async insertOutbox(
    client: PoolClient,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [aggregateType, aggregateId, eventType, JSON.stringify(payload)],
    );
  }

  private async insertAudit(
    client: PoolClient,
    context: AccessContext,
    action: string,
    resourceType: string,
    resourceId: string,
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs (
         actor_user_id, actor_roles, authz_version, action, resource_type,
         resource_id, result, reason, metadata, request_id, trace_id
       ) VALUES ($1,$2,$3,$4,$5,$6,'SUCCESS',left($7,300),$8::jsonb,$9,$10)`,
      [
        context.user.userId,
        [...context.user.roles],
        context.user.authzVersion,
        action,
        resourceType,
        resourceId,
        reason,
        JSON.stringify(metadata),
        context.requestId,
        context.traceId ?? null,
      ],
    );
  }
}

function mapRun(row: IndexingRunRow): IndexingRun {
  return IndexingRunSchema.parse({
    id: row.id,
    jobId: row.job_id,
    spaceId: row.space_id,
    documentVersionId: row.document_version_id,
    contentRevision: row.content_revision,
    embeddingRevision: row.embedding_revision,
    providerProfile: row.provider_profile,
    embeddingProfileId: row.embedding_profile_id,
    embeddingModelId: row.embedding_model_id,
    embeddingModelRevision: row.embedding_model_revision,
    collectionName: row.collection_name,
    manifestId: row.manifest_id,
    manifestVersion: row.manifest_version,
    status: row.status,
    expectedVectorCount: row.expected_vector_count,
    embeddedCount: row.embedded_count,
    reusedCount: row.reused_count,
    indexedCount: row.indexed_count,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    startedAt: iso(row.started_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapManifest(row: ManifestRow): SpaceManifest {
  return SpaceManifestSchema.parse({
    id: row.id,
    spaceId: row.space_id,
    version: row.version,
    status: row.status,
    providerProfile: row.provider_profile,
    embeddingProfileId: row.embedding_profile_id,
    embeddingModelId: row.embedding_model_id,
    embeddingModelRevision: row.embedding_model_revision,
    tokenizerRevision: row.tokenizer_revision,
    denseDimension: row.dense_dimension,
    normalizeDense: row.normalize_dense,
    sparseFormatVersion: row.sparse_format_version,
    collectionName: row.collection_name,
    expectedVectorCount: row.expected_vector_count,
    actualVectorCount: row.actual_vector_count,
    reconciliationSha256: row.reconciliation_sha256,
    activatedAt: row.activated_at ? iso(row.activated_at) : null,
    createdAt: iso(row.created_at),
  });
}

function mapMember(row: MemberRow): ManifestDocumentMember {
  return ManifestDocumentMemberSchema.parse({
    manifestId: row.manifest_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    contentRevision: row.content_revision,
    embeddingRevision: row.embedding_revision,
    vectorCount: row.vector_count,
  });
}

function mapChunk(row: ChunkRow): IndexableChunk {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    contentRevision: row.content_revision,
    ordinal: row.ordinal,
    embeddingText: row.embedding_text,
    displayContent: row.display_content,
    tokenCount: row.token_count,
    contentSha256: row.content_sha256,
    headingPath: Array.isArray(row.heading_path)
      ? row.heading_path.filter((item): item is string => typeof item === 'string')
      : [],
    sourceLocations: Array.isArray(row.source_locations) ? row.source_locations : [],
  };
}

function mapEmbeddingFact(row: EmbeddingFactRow): EmbeddingFact {
  return {
    id: row.id,
    embeddingProfileId: row.embedding_profile_id,
    contentSha256: row.content_sha256,
    dense: parseDense(row.dense_vector),
    sparse: parseSparse(row.sparse_vector),
    modelId: row.model_id,
    modelRevision: row.model_revision,
  };
}

function mapRebuild(row: RebuildRow): IndexRebuild {
  return IndexRebuildSchema.parse({
    id: row.id,
    spaceId: row.space_id,
    embeddingProfileId: row.embedding_profile_id,
    mode: row.mode,
    canaryPercent: row.canary_percent,
    status: row.status,
    candidateManifestId: row.candidate_manifest_id,
    previousManifestId: row.previous_manifest_id,
    pipelineJobId: row.pipeline_job_id,
    evaluationReport: row.evaluation_report === null ? null : asJsonRecord(row.evaluation_report),
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: iso(row.created_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
  });
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseDense(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new ApplicationError('SCHEMA_MISMATCH', 500, 'Embedding 事实 Dense Schema 非法');
  }
  return value;
}

function parseSparse(value: unknown): SparseVector | null {
  if (value === null) return null;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('indices' in value) ||
    !('values' in value)
  ) {
    throw new ApplicationError('SCHEMA_MISMATCH', 500, 'Embedding 事实 Sparse Schema 非法');
  }
  const candidate = value as { indices: unknown; values: unknown };
  if (!Array.isArray(candidate.indices) || !Array.isArray(candidate.values)) {
    throw new ApplicationError('SCHEMA_MISMATCH', 500, 'Embedding 事实 Sparse Schema 非法');
  }
  return {
    indices: candidate.indices.map(Number),
    values: candidate.values.map(Number),
  };
}

function profileCompatibilitySha256(profile: EmbeddingProfile): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: profile.provider,
        modelId: profile.modelId,
        revision: profile.revision,
        protocolVersion: profile.protocolVersion,
        tokenizerRevision: profile.tokenizerRevision,
        denseDimension: profile.denseDimension,
        normalizeDense: profile.normalizeDense,
        sparseFormatVersion: profile.sparseFormatVersion,
        documentTemplateVersion: profile.documentTemplateVersion,
        queryTemplateVersion: profile.queryTemplateVersion,
      }),
    )
    .digest('hex');
}

function sanitizeIdentifier(input: string): string {
  const sanitized = input.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]/, '_');
  return sanitized.slice(0, 220) || 'rag_index';
}

function previousM05Step(
  step: 'EMBED' | 'INDEX' | 'VERIFY' | 'PUBLISH',
): 'EMBED' | 'INDEX' | 'VERIFY' | null {
  if (step === 'INDEX') return 'EMBED';
  if (step === 'VERIFY') return 'INDEX';
  if (step === 'PUBLISH') return 'VERIFY';
  return null;
}

function overallAtStep(step: 'EMBED' | 'INDEX' | 'VERIFY' | 'PUBLISH'): number {
  return { EMBED: 75, INDEX: 87, VERIFY: 95, PUBLISH: 98 }[step];
}

function runStatusAtStep(
  step: 'EMBED' | 'INDEX' | 'VERIFY' | 'PUBLISH',
): 'EMBEDDING' | 'INDEXING' | 'VERIFYING' | 'VERIFIED' {
  return { EMBED: 'EMBEDDING', INDEX: 'INDEXING', VERIFY: 'VERIFYING', PUBLISH: 'VERIFIED' }[
    step
  ] as 'EMBEDDING' | 'INDEXING' | 'VERIFYING' | 'VERIFIED';
}

function requireRow<T>(value: T | undefined, message: string): T {
  if (!value) throw new ApplicationError('INVALID_STATE', 409, message);
  return value;
}

function requireValue(value: string | null, message: string): string {
  if (!value) throw new ApplicationError('INVALID_STATE', 409, message);
  return value;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
