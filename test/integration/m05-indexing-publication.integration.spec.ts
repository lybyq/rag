/**
 * M05 真实 PostgreSQL + 内存向量库集成门禁。
 *
 * 本测试用公开合成 Chunk 验证：M04→M05 交接、Embedding 事实复用、Manifest 原子发布、
 * 构建失败不切 Head、历史回滚，以及撤权/废止事件与业务事务一起进入 Outbox。
 * 真实内网 Milvus 的 SDK 契约由 Adapter 单测覆盖，CI 不依赖外部模型或公网。
 *
 * @requirement IDX-005
 * @requirement IDX-009
 * @requirement IDX-011
 * @requirement IDX-012
 * @requirement IDX-013
 */
import {
  IndexingService,
  ProfileRolloutService,
  type AccessContext,
  type EmbeddingPort,
  type VectorIndexPort,
} from '@rag/application';
import { loadAppConfig } from '@rag/config';
import type { EmbeddingBatchResponse, EmbeddingInput, EmbeddingProfile } from '@rag/contracts';
import { MemoryVectorIndexAdapter } from '@rag/persistence-milvus';
import {
  PostgresDocumentIngestionRepository,
  PostgresIndexingRepository,
  PostgresKnowledgeSpaceRepository,
} from '@rag/persistence-pg';
import { createTestUserContext } from '@rag/testing';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const describeWithInfra = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeWithInfra('[IDX-005][IDX-009][IDX-011][IDX-012][IDX-013][IDX-016] M05 publication', () => {
  const config = loadAppConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
  const spaces = new PostgresKnowledgeSpaceRepository(pool);
  const ingestion = new PostgresDocumentIngestionRepository(pool);
  const indexing = new PostgresIndexingRepository(pool, config);
  const vector = new MemoryVectorIndexAdapter();
  const suffix = Date.now().toString(36);
  const owner: AccessContext = {
    user: createTestUserContext(`m05-owner-${suffix}`, ['KNOWLEDGE_EDITOR', 'SYSTEM_ADMIN']),
    requestId: `m05-request-${suffix}`,
    traceId: `m05-trace-${suffix}`,
  };
  const profile: EmbeddingProfile = {
    profileId: `m05-integration-${suffix}`,
    providerProfile: 'external-ci',
    provider: 'integration-fixture',
    modelId: 'integration-embedding',
    revision: `1-${suffix}`,
    protocolVersion: '1',
    tokenizerRevision: 'integration-tokenizer-v1',
    denseDimension: 2,
    normalizeDense: true,
    sparseFormatVersion: null,
    documentTemplateVersion: 'document-v1',
    queryTemplateVersion: 'query-v1',
    maxInputTokens: 1024,
    maxBatchSize: 8,
  };
  const rolloutProfile: EmbeddingProfile = {
    ...profile,
    profileId: `m05-rollout-${suffix}`,
    revision: `2-${suffix}`,
  };
  let spaceId = '';

  beforeAll(async () => {
    spaceId = (
      await spaces.create(owner, {
        code: `m05-it-${suffix}`,
        name: 'M05 集成测试空间',
        description: null,
        ownerUserId: owner.user.userId,
      })
    ).id;
  });

  afterAll(async () => {
    if (spaceId) await cleanupSpace(pool, spaceId, [profile.profileId, rolloutProfile.profileId]);
    await pool.end();
  });

  it('连续发布只切换 PG Head，重复内容按 Hash + Profile 复用向量事实', async () => {
    const first = await seedM04PassedDocument(
      pool,
      spaceId,
      owner.user.userId,
      suffix,
      1,
      '共享制度正文',
    );
    await expect(runIndexing(first.jobId, vector)).resolves.toBe('PUBLISHED');
    const firstHead = await activeHead(pool, spaceId);
    expect(firstHead.version).toBe(1);

    const second = await seedM04PassedDocument(
      pool,
      spaceId,
      owner.user.userId,
      suffix,
      2,
      '共享制度正文',
    );
    await expect(runIndexing(second.jobId, vector)).resolves.toBe('PUBLISHED');
    const secondHead = await activeHead(pool, spaceId);
    expect(secondHead.version).toBe(2);
    expect(secondHead.manifestId).not.toBe(firstHead.manifestId);

    const memberCount = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM manifest_document_members WHERE manifest_id = $1`,
      [secondHead.manifestId],
    );
    expect(memberCount.rows[0]?.count).toBe(2);
    const facts = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM embedding_facts WHERE embedding_profile_id = $1`,
      [profile.profileId],
    );
    // 两个文档内容完全相同，因此只能存在一个可复用事实；来源成员仍然保持两条。
    expect(facts.rows[0]?.count).toBe(1);

    const publishEvents = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbox_events
        WHERE event_type = 'index.manifest.published' AND payload->>'spaceId' = $1`,
      [spaceId],
    );
    expect(publishEvents.rows[0]?.count).toBe(2);
  });

  it('Milvus 构建失败不会改变当前 ACTIVE Head，之后仍可一键回滚历史版本', async () => {
    const before = await activeHead(pool, spaceId);
    const failed = await seedM04PassedDocument(
      pool,
      spaceId,
      owner.user.userId,
      suffix,
      3,
      '触发失败的正文',
    );
    const failingVector: VectorIndexPort = {
      ...vector,
      ensureProfileCollection: vector.ensureProfileCollection.bind(vector),
      upsertManifestRecords: async () => {
        throw new Error('synthetic milvus unavailable');
      },
      listManifestRecordFacts: vector.listManifestRecordFacts.bind(vector),
      lookupRecordIds: vector.lookupRecordIds.bind(vector),
      searchManifestDense: vector.searchManifestDense.bind(vector),
      deleteManifestRecords: vector.deleteManifestRecords.bind(vector),
    };
    await expect(runIndexing(failed.jobId, failingVector)).resolves.toBe('FAILED');
    await expect(activeHead(pool, spaceId)).resolves.toEqual(before);

    const rolledBack = await indexing.rollback(owner, spaceId, {
      targetManifestVersion: 1,
      reason: '集成测试验证一键回滚',
    });
    expect(rolledBack.version).toBe(1);
    expect((await activeHead(pool, spaceId)).version).toBe(1);
  });

  it('新 Profile 自动构建候选、离线评测、登记 CANARY，并可提升和请求级回退', async () => {
    const stableBefore = await activeHead(pool, spaceId);
    const requestId = await indexing.enqueueProfileRebuild(
      owner,
      spaceId,
      rolloutProfile.profileId,
      'CANARY',
      20,
      '集成测试 Profile 灰度升级',
    );
    const buildWorker = `rollout-build-${randomUUID()}`;
    const buildTask = (await indexing.claimProfileRebuildTasks(buildWorker, 10, 180)).find(
      (item) => item.requestId === requestId,
    )!;
    expect(buildTask.action).toBe('BUILD');
    const rebuildJobId = await indexing.prepareProfileRebuild(
      requestId,
      buildWorker,
      rolloutProfile,
    );
    await markRebuildM04Passed(pool, rebuildJobId, suffix);
    await expect(runIndexing(rebuildJobId, vector, rolloutProfile)).resolves.toBe('STAGED');
    await expect(activeHead(pool, spaceId)).resolves.toEqual(stableBefore);

    const evaluationWorker = `rollout-eval-${randomUUID()}`;
    const evaluationTask = (
      await indexing.claimProfileRebuildTasks(evaluationWorker, 10, 180)
    ).find((item) => item.requestId === requestId)!;
    expect(evaluationTask.action).toBe('EVALUATE');
    const rollout = new ProfileRolloutService(indexing, embeddingFixture(rolloutProfile), vector, {
      profile: rolloutProfile,
      requestTimeoutMs: 3_000,
      overallDeadlineMs: 30_000,
      maxCases: 20,
      evaluationTopK: 5,
      minimumRecall: 1,
      maxAttempts: 3,
      retryBaseDelayMs: 10,
    });
    await expect(rollout.process(evaluationTask, evaluationWorker)).resolves.toBe('CANARY_READY');
    expect((await indexing.getProfileRebuild(owner, spaceId, requestId))?.status).toBe('READY');
    await expect(activeHead(pool, spaceId)).resolves.toEqual(stableBefore);

    const promoted = await indexing.promoteProfileRebuild(
      owner,
      spaceId,
      requestId,
      '灰度观察通过，提升稳定版本',
    );
    expect(promoted.embeddingProfileId).toBe(rolloutProfile.profileId);
    expect((await activeHead(pool, spaceId)).manifestId).toBe(promoted.id);

    const rolledBack = await indexing.rollbackProfileRebuild(
      owner,
      spaceId,
      requestId,
      '集成验证请求级一键回退',
    );
    expect(rolledBack.id).toBe(stableBefore.manifestId);
    expect((await indexing.getProfileRebuild(owner, spaceId, requestId))?.status).toBe(
      'ROLLED_BACK',
    );
  });

  it('撤权和空间废止均在同一事务可靠产生缓存失效事件', async () => {
    const grant = await spaces.upsertGrant(owner, spaceId, {
      subjectType: 'ROLE',
      subjectId: `m05-reader-${suffix}`,
      permissions: ['READ'],
      reason: '集成测试临时授权',
    });
    await spaces.revokeGrant(owner, spaceId, grant.id, '集成测试撤权');
    const current = await spaces.findById(owner, spaceId);
    await spaces.deactivate(owner, spaceId, current!.version);

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events
        WHERE payload->>'spaceId' = $1
          AND event_type IN ('index.authorization.revoked','index.space.revoked','cache.invalidate.space')`,
      [spaceId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        'index.authorization.revoked',
        'index.space.revoked',
        'cache.invalidate.space',
      ]),
    );
  });

  async function runIndexing(
    jobId: string,
    vectorIndex: VectorIndexPort,
    selectedProfile: EmbeddingProfile = profile,
  ): Promise<string> {
    const workerId = `m05-worker-${randomUUID()}`;
    const lease = await ingestion.acquireJobLease(jobId, workerId, 180);
    expect(lease?.currentStep).toBe('EMBED');
    const service = new IndexingService(indexing, embeddingFixture(selectedProfile), vectorIndex, {
      profile: selectedProfile,
      requestTimeoutMs: 3_000,
      overallDeadlineMs: 30_000,
      maxBatchTokens: 2_048,
      maxConcurrency: 2,
      maxAttempts: 2,
      retryBaseDelayMs: 1,
      maxQueuedItems: 16,
      vectorWriteBatchSize: 8,
      vectorWriteMaxAttempts: 2,
    });
    return service.process(jobId, workerId);
  }
});

/** 构造一个已通过 M04、当前等待 EMBED 的最小真实数据库快照。 */
async function seedM04PassedDocument(
  pool: Pool,
  spaceId: string,
  userId: string,
  suffix: string,
  sequence: number,
  text: string,
): Promise<{ jobId: string }> {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const jobId = `m05:${suffix}:${sequence}:${randomUUID()}`;
  const parseRunId = randomUUID();
  const processingRunId = randomUUID();
  const parentId = `m05-parent-${suffix}-${sequence}`;
  const childId = `m05-child-${suffix}-${sequence}`;
  const sha = createHash('sha256').update(text).digest('hex');
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO documents (id, space_id, title, created_by) VALUES ($1,$2,$3,$4)`,
      [documentId, spaceId, `M05 合成文档 ${sequence}`, userId],
    );
    await client.query(
      `INSERT INTO document_versions (id, document_id, version_number, content_revision, status, created_by)
       VALUES ($1,$2,1,1,'WAITING',$3)`,
      [versionId, documentId, userId],
    );
    await client.query(
      `INSERT INTO document_files (
         document_version_id, original_file_name, bucket, object_key, size_bytes, content_type, sha256
       ) VALUES ($1,$2,'rag-uploads',$3,100,'text/plain',$4)`,
      [versionId, `m05-${sequence}.txt`, `integration/${spaceId}/${versionId}.txt`, sha],
    );
    await client.query(
      `INSERT INTO ingestion_jobs (
         id, document_id, document_version_id, content_revision, pipeline_version,
         status, current_step, overall_percent, public_message
       ) VALUES ($1,$2,$3,1,1,'WAITING','EMBED',75,'等待向量化')`,
      [jobId, documentId, versionId],
    );
    const steps = [
      'SECURITY_SCAN',
      'PARSE',
      'OCR',
      'NORMALIZE',
      'CHUNK',
      'QUALITY_GATE',
      'EMBED',
      'INDEX',
      'VERIFY',
      'PUBLISH',
    ];
    for (const [index, step] of steps.entries()) {
      const succeeded = index < 6;
      await client.query(
        `INSERT INTO ingestion_job_steps (
           id, job_id, step_name, position, status, weight_percent,
           processed_units, total_units, stage_percent, overall_percent
         ) VALUES ($1,$2,$3,$4,$5,10,$6,1,$7,$8)`,
        [
          `${jobId}:${step}:v1`,
          jobId,
          step,
          index + 1,
          succeeded ? 'SUCCEEDED' : 'QUEUED',
          succeeded ? 1 : 0,
          succeeded ? 100 : 0,
          succeeded ? Math.min(75, (index + 1) * 12) : 75,
        ],
      );
    }
    await client.query(
      `INSERT INTO document_parse_runs (
         id, job_id, document_version_id, content_revision, status, file_format,
         parser_profile_id, parser_revision, ocr_profile_id, ocr_revision
       ) VALUES ($1,$2,$3,1,'SUCCEEDED','TEXT','integration-parser','1','integration-ocr','1')`,
      [parseRunId, jobId, versionId],
    );
    await client.query(
      `INSERT INTO knowledge_processing_runs (
         id, job_id, parse_run_id, document_version_id, content_revision, file_format,
         status, chunker_profile_id, chunker_revision, tokenizer_profile_id,
         tokenizer_revision, quality_rule_version, parent_chunk_count, child_chunk_count
       ) VALUES ($1,$2,$3,$4,1,'TEXT','SUCCEEDED','integration-chunker','1',
                 'integration-tokenizer','1','integration-quality',1,1)`,
      [processingRunId, jobId, parseRunId, versionId],
    );
    await client.query(
      `INSERT INTO knowledge_chunks (
         id, processing_run_id, document_version_id, content_revision, ordinal,
         granularity, content_type, display_content, embedding_text, token_count,
         tokenizer_profile_id, tokenizer_revision, source_locations, content_sha256,
         dedup_status, eligible_for_index, parent_chunk_id
       ) VALUES
       ($1,$3,$4,1,1,'PARENT','PROSE',$5,$5,8,'integration-tokenizer','1','[]',$6,'UNIQUE',false,NULL),
       ($2,$3,$4,1,2,'CHILD','PROSE',$5,$5,8,'integration-tokenizer','1','[]',$6,'UNIQUE',true,$1)`,
      [parentId, childId, processingRunId, versionId, text, sha],
    );
    await client.query(
      `INSERT INTO document_quality_reports (
         processing_run_id, document_version_id, content_revision, verdict, rule_version,
         metrics, review_decision, eligible_for_index
       ) VALUES ($1,$2,1,'PASS','integration-quality','{}','NOT_REQUIRED',true)`,
      [processingRunId, versionId],
    );
    await client.query('COMMIT');
    return { jobId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 为 prepareProfileRebuild 创建的标准 Job 补出合成 M03/M04 成功事实。 */
async function markRebuildM04Passed(pool: Pool, jobId: string, suffix: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = await client.query<{
      document_version_id: string;
      content_revision: number;
    }>(
      'SELECT document_version_id, content_revision FROM ingestion_jobs WHERE id = $1 FOR UPDATE',
      [jobId],
    );
    const row = job.rows[0]!;
    const parseRunId = randomUUID();
    const processingRunId = randomUUID();
    const parentId = `m05-rollout-parent-${suffix}`;
    const childId = `m05-rollout-child-${suffix}`;
    const text = 'Profile 重建代表查询正文';
    const sha = createHash('sha256').update(text).digest('hex');
    await client.query(
      `INSERT INTO document_parse_runs (
         id, job_id, document_version_id, content_revision, status, file_format,
         parser_profile_id, parser_revision, ocr_profile_id, ocr_revision
       ) VALUES ($1,$2,$3,$4,'SUCCEEDED','TEXT','rollout-parser','1','rollout-ocr','1')`,
      [parseRunId, jobId, row.document_version_id, row.content_revision],
    );
    await client.query(
      `INSERT INTO knowledge_processing_runs (
         id, job_id, parse_run_id, document_version_id, content_revision, file_format,
         status, chunker_profile_id, chunker_revision, tokenizer_profile_id,
         tokenizer_revision, quality_rule_version, parent_chunk_count, child_chunk_count
       ) VALUES ($1,$2,$3,$4,$5,'TEXT','SUCCEEDED','rollout-chunker','1',
                 'rollout-tokenizer','1','rollout-quality',1,1)`,
      [processingRunId, jobId, parseRunId, row.document_version_id, row.content_revision],
    );
    await client.query(
      `INSERT INTO knowledge_chunks (
         id, processing_run_id, document_version_id, content_revision, ordinal,
         granularity, content_type, display_content, embedding_text, token_count,
         tokenizer_profile_id, tokenizer_revision, source_locations, content_sha256,
         dedup_status, eligible_for_index, parent_chunk_id
       ) VALUES
       ($1,$3,$4,$5,1,'PARENT','PROSE',$6,$6,8,'rollout-tokenizer','1','[]',$7,'UNIQUE',false,NULL),
       ($2,$3,$4,$5,2,'CHILD','PROSE',$6,$6,8,'rollout-tokenizer','1','[]',$7,'UNIQUE',true,$1)`,
      [
        parentId,
        childId,
        processingRunId,
        row.document_version_id,
        row.content_revision,
        text,
        sha,
      ],
    );
    await client.query(
      `INSERT INTO document_quality_reports (
         processing_run_id, document_version_id, content_revision, verdict, rule_version,
         metrics, review_decision, eligible_for_index
       ) VALUES ($1,$2,$3,'PASS','rollout-quality','{}','NOT_REQUIRED',true)`,
      [processingRunId, row.document_version_id, row.content_revision],
    );
    await client.query(
      `UPDATE ingestion_job_steps SET status = CASE WHEN position <= 6 THEN 'SUCCEEDED' ELSE 'QUEUED' END,
              stage_percent = CASE WHEN position <= 6 THEN 100 ELSE NULL END,
              overall_percent = 75, processed_units = CASE WHEN position <= 6 THEN 1 ELSE 0 END,
              total_units = CASE WHEN position <= 6 THEN 1 ELSE NULL END,
              finished_at = CASE WHEN position <= 6 THEN now() ELSE NULL END,
              updated_at = now() WHERE job_id = $1`,
      [jobId],
    );
    await client.query(
      `UPDATE ingestion_jobs SET status = 'WAITING', current_step = 'EMBED',
              overall_percent = 75, public_message = '等待 Profile 候选向量化', updated_at = now()
        WHERE id = $1`,
      [jobId],
    );
    await client.query(
      `UPDATE document_versions SET status = 'WAITING', updated_at = now() WHERE id = $1`,
      [row.document_version_id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 本地确定性 Embedding，模拟内网 HTTP Provider 的已校验输出契约。 */
function embeddingFixture(profile: EmbeddingProfile): EmbeddingPort {
  const response = (inputs: readonly EmbeddingInput[]): EmbeddingBatchResponse => ({
    outputs: inputs.map((input) => ({
      itemId: input.itemId,
      contentSha256: input.contentSha256,
      dense: [1, 0],
      sparse: null,
      modelId: profile.modelId,
      revision: profile.revision,
    })),
    failures: [],
  });
  return {
    checkHealth: async () => undefined,
    getMetadata: async () => ({
      provider: profile.provider,
      modelId: profile.modelId,
      revision: profile.revision,
      protocolVersion: profile.protocolVersion,
      tokenizerRevision: profile.tokenizerRevision,
      denseDimension: profile.denseDimension,
      normalizeDense: profile.normalizeDense,
      sparseFormatVersion: profile.sparseFormatVersion,
      maxInputTokens: profile.maxInputTokens,
      maxBatchSize: profile.maxBatchSize,
      capabilities: ['query', 'document', 'dense'],
    }),
    embedDocuments: async (inputs) => response(inputs),
    embedQueries: async (inputs) => response(inputs),
  };
}

/** 查询线上唯一 Head；测试不通过 Milvus 记录推断可见版本。 */
async function activeHead(
  pool: Pool,
  spaceId: string,
): Promise<{ manifestId: string; version: number }> {
  const result = await pool.query<{ active_manifest_id: string; active_manifest_version: number }>(
    `SELECT active_manifest_id, active_manifest_version FROM space_manifest_heads WHERE space_id = $1`,
    [spaceId],
  );
  return {
    manifestId: result.rows[0]!.active_manifest_id,
    version: result.rows[0]!.active_manifest_version,
  };
}

/** 按外键逆序只清理本测试空间，绝不删除其他开发数据。 */
async function cleanupSpace(
  pool: Pool,
  spaceId: string,
  profileIds: readonly string[],
): Promise<void> {
  const documentFilter = `SELECT id FROM documents WHERE space_id = $1::uuid`;
  const versionFilter = `SELECT id FROM document_versions WHERE document_id IN (${documentFilter})`;
  const jobFilter = `SELECT id FROM ingestion_jobs WHERE document_id IN (${documentFilter})`;
  const manifestFilter = `SELECT id FROM space_manifests WHERE space_id = $1::uuid`;
  const runFilter = `SELECT id FROM indexing_runs WHERE space_id = $1::uuid`;
  await pool.query(
    `DELETE FROM outbox_consumer_receipts WHERE event_id IN (
    SELECT id FROM outbox_events WHERE payload->>'spaceId' = $1::text OR aggregate_id IN (${jobFilter})
  )`,
    [spaceId],
  );
  await pool.query(
    `DELETE FROM outbox_events WHERE payload->>'spaceId' = $1::text OR aggregate_id IN (${jobFilter})`,
    [spaceId],
  );
  await pool.query(`DELETE FROM space_manifest_canaries WHERE space_id = $1`, [spaceId]);
  await pool.query(
    `DELETE FROM index_rebuild_jobs WHERE request_id IN (
    SELECT id FROM index_rebuild_requests WHERE space_id = $1
  )`,
    [spaceId],
  );
  await pool.query(`DELETE FROM index_rebuild_requests WHERE space_id = $1`, [spaceId]);
  await pool.query(`DELETE FROM index_maintenance_tasks WHERE manifest_id IN (${manifestFilter})`, [
    spaceId,
  ]);
  await pool.query(
    `DELETE FROM index_reconciliation_reports WHERE manifest_id IN (${manifestFilter})`,
    [spaceId],
  );
  await pool.query(`DELETE FROM chunk_embedding_refs WHERE indexing_run_id IN (${runFilter})`, [
    spaceId,
  ]);
  await pool.query(`DELETE FROM indexing_runs WHERE space_id = $1`, [spaceId]);
  await pool.query(`DELETE FROM space_manifest_heads WHERE space_id = $1`, [spaceId]);
  await pool.query(
    `DELETE FROM manifest_document_members WHERE manifest_id IN (${manifestFilter})`,
    [spaceId],
  );
  await pool.query(`DELETE FROM protected_resource_spaces WHERE space_id = $1`, [spaceId]);
  await pool.query(`DELETE FROM space_manifests WHERE space_id = $1`, [spaceId]);
  await pool.query(`DELETE FROM embedding_facts WHERE embedding_profile_id = ANY($1::text[])`, [
    [...profileIds],
  ]);
  await pool.query(
    `DELETE FROM embedding_collection_registry WHERE embedding_profile_id = ANY($1::text[])`,
    [[...profileIds]],
  );
  await pool.query(
    `DELETE FROM document_quality_findings WHERE report_id IN (
    SELECT id FROM document_quality_reports WHERE document_version_id IN (${versionFilter})
  )`,
    [spaceId],
  );
  await pool.query(
    `DELETE FROM knowledge_quality_reviews WHERE report_id IN (
    SELECT id FROM document_quality_reports WHERE document_version_id IN (${versionFilter})
  )`,
    [spaceId],
  );
  await pool.query(
    `DELETE FROM document_quality_reports WHERE document_version_id IN (${versionFilter})`,
    [spaceId],
  );
  await pool.query(`DELETE FROM knowledge_chunks WHERE document_version_id IN (${versionFilter})`, [
    spaceId,
  ]);
  await pool.query(
    `DELETE FROM knowledge_processing_runs WHERE document_version_id IN (${versionFilter})`,
    [spaceId],
  );
  await pool.query(
    `DELETE FROM document_parse_runs WHERE document_version_id IN (${versionFilter})`,
    [spaceId],
  );
  await pool.query(`DELETE FROM ingestion_job_events WHERE job_id IN (${jobFilter})`, [spaceId]);
  await pool.query(`DELETE FROM ingestion_job_steps WHERE job_id IN (${jobFilter})`, [spaceId]);
  await pool.query(`DELETE FROM ingestion_jobs WHERE document_id IN (${documentFilter})`, [
    spaceId,
  ]);
  await pool.query(`DELETE FROM document_files WHERE document_version_id IN (${versionFilter})`, [
    spaceId,
  ]);
  await pool.query(`DELETE FROM document_versions WHERE document_id IN (${documentFilter})`, [
    spaceId,
  ]);
  await pool.query(`DELETE FROM documents WHERE space_id = $1`, [spaceId]);
  await pool.query(`DELETE FROM audit_logs WHERE resource_id = $1 OR metadata->>'spaceId' = $1`, [
    spaceId,
  ]);
  await pool.query(`DELETE FROM knowledge_space_policies WHERE space_id = $1`, [spaceId]);
  await pool.query(`DELETE FROM resource_acl WHERE resource_id = $1`, [spaceId]);
  await pool.query(`DELETE FROM knowledge_spaces WHERE id = $1`, [spaceId]);
}
