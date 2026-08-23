/**
 * 查询规划与混合检索 PostgreSQL 批量回源集成门禁。
 *
 * 使用真实迁移后的 PostgreSQL 验证 vectorId 单批关联、Manifest 成员/版本、文档状态、发布时间、
 * 生效窗口和当前允许空间的 fail-closed 复核。测试不连接公网模型或 Milvus。
 *
 * @requirement RET-006
 * @requirement RET-007
 * @requirement RET-012
 * @requirement RET-013
 */
import type {
  AccessContext,
  ExpandEvidenceCommand,
  HydrateRetrievalCandidatesCommand,
} from '@rag/application';
import { loadAppConfig } from '@rag/config';
import type { RagRun } from '@rag/contracts';
import {
  PostgresEvidenceSourceRepository,
  PostgresRagRunRepository,
  PostgresRetrievalRepository,
} from '@rag/persistence-pg';
import { createTestUserContext } from '@rag/testing';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const describeWithInfra = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeWithInfra('[RET-012][RET-013] 查询规划与混合检索 PostgreSQL retrieval source', () => {
  const config = loadAppConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const repository = new PostgresRetrievalRepository(pool);
  const evidenceRepository = new PostgresEvidenceSourceRepository(pool);
  const runRepository = new PostgresRagRunRepository(pool);
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    space: randomUUID(),
    document: randomUUID(),
    version: randomUUID(),
    parseRun: randomUUID(),
    processingRun: randomUUID(),
    manifest: randomUUID(),
    indexingRun: randomUUID(),
    embeddingFact: randomUUID(),
    conversation: randomUUID(),
    run: randomUUID(),
    userMessage: randomUUID(),
  };
  const jobId = `hybrid-retrieval-source-${suffix}`;
  const profileId = `hybrid-retrieval-profile-${suffix}`;
  const parentChunkId = `hybrid-retrieval-parent-${suffix}`;
  const childChunkId = `hybrid-retrieval-child-${suffix}`;
  const nextChunkId = `hybrid-retrieval-next-${suffix}`;
  const tableHeaderBlockId = `hybrid-retrieval-header-${suffix}`;
  const vectorId = createHash('sha256')
    .update(`${ids.manifest}:${childChunkId}:${profileId}`)
    .digest('hex');
  const context: AccessContext = {
    user: createTestUserContext(`hybrid-retrieval-user-${suffix}`, ['SYSTEM_ADMIN']),
    requestId: `hybrid-retrieval-request-${suffix}`,
  };

  beforeAll(async () => seed(pool));
  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  test('一次批量查询返回 PG 正文并通过所有当前事实复核', async () => {
    const result = await repository.hydrateAndRecheck(context, command());
    expect(result.removedByReason).toEqual({});
    expect(result.candidates).toEqual([
      expect.objectContaining({
        vectorId,
        chunkId: childChunkId,
        documentId: ids.document,
        documentVersionId: ids.version,
        displayContent: '查询规划与混合检索 合成差旅制度正文',
      }),
    ]);
  });

  test('归档、未来生效、Manifest 版本错误和撤权均不能泄漏候选', async () => {
    await pool.query(`UPDATE documents SET status = 'ARCHIVED' WHERE id = $1`, [ids.document]);
    await expect(repository.hydrateAndRecheck(context, command())).resolves.toMatchObject({
      candidates: [],
      removedByReason: { SOURCE_RECHECK_FAILED: 1 },
    });
    await pool.query(
      `UPDATE documents SET status = 'ACTIVE', effective_from = now() + interval '1 day' WHERE id = $1`,
      [ids.document],
    );
    await expect(repository.hydrateAndRecheck(context, command())).resolves.toMatchObject({
      candidates: [],
    });
    await pool.query(
      `UPDATE documents SET effective_from = now() - interval '1 day' WHERE id = $1`,
      [ids.document],
    );
    const wrongVersion = command();
    await expect(
      repository.hydrateAndRecheck(context, {
        ...wrongVersion,
        manifests: wrongVersion.manifests.map((manifest) => ({
          ...manifest,
          manifestVersion: 99,
        })),
      }),
    ).resolves.toMatchObject({ candidates: [] });
    await expect(
      repository.hydrateAndRecheck(context, {
        ...command(),
        currentlyAllowedSpaceIds: [],
      }),
    ).resolves.toEqual({ candidates: [], removedByReason: { ACCESS_DENIED: 1 } });
  });

  test('调用方伪造允许空间列表也不能绕过 PostgreSQL 当前 ACL 复核', async () => {
    const readerContext: AccessContext = {
      user: createTestUserContext(`hybrid-retrieval-reader-${suffix}`, ['KNOWLEDGE_READER']),
      requestId: `hybrid-retrieval-reader-request-${suffix}`,
    };

    // currentlyAllowedSpaceIds 属于应用层计算结果，但 Repository 仍必须 fail-closed，不能盲目信任它。
    await expect(repository.hydrateAndRecheck(readerContext, command())).resolves.toMatchObject({
      candidates: [],
    });

    await pool.query(
      `INSERT INTO resource_acl (
         resource_type, resource_id, subject_type, subject_id, permissions, created_by
       ) VALUES ('KNOWLEDGE_SPACE', $1, 'ROLE', 'KNOWLEDGE_READER', ARRAY['READ']::text[], $2)`,
      [ids.space, context.user.userId],
    );
    await expect(repository.hydrateAndRecheck(readerContext, command())).resolves.toMatchObject({
      candidates: [expect.objectContaining({ vectorId })],
    });
  });

  test('[ANS-003][ANS-011] 扩展父块、相邻块和表头后再次校验当前来源事实', async () => {
    const hydrated = await repository.hydrateAndRecheck(context, command());
    const expansion: ExpandEvidenceCommand = {
      run: runFixture(),
      candidates: hydrated.candidates,
      manifests: command().manifests,
      currentlyAllowedSpaceIds: [ids.space],
      asOf: new Date(),
    };
    const expanded = await evidenceRepository.expandAndRecheck(context, expansion);
    expect(expanded.materials.map((item) => item.relation)).toEqual([
      'SELF',
      'PARENT',
      'NEXT',
      'TABLE_HEADER',
    ]);
    expect(expanded.materials.find((item) => item.relation === 'TABLE_HEADER')).toMatchObject({
      content: '报销项目 | 所需凭证',
    });

    const sources = expanded.materials.map((item, index) => ({
      ...item,
      headingPath: [...item.headingPath],
      sourceLocations: [...item.sourceLocations],
      sourceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      authority: 'POLICY' as const,
      retrievalScore: 0.8,
      rerankerScore: 0.9,
      subQuestionIndexes: [0],
    }));
    await expect(
      evidenceRepository.revalidateSources(context, sources, new Date()),
    ).resolves.toHaveLength(4);
    await pool.query(
      `UPDATE documents SET effective_to = now() - interval '1 minute' WHERE id = $1`,
      [ids.document],
    );
    await expect(
      evidenceRepository.revalidateSources(context, sources, new Date()),
    ).resolves.toEqual([]);
    await pool.query(`UPDATE documents SET effective_to = NULL WHERE id = $1`, [ids.document]);

    await seedAnswerRun(pool, runFixture());
    const answerSha256 = createHash('sha256').update('校验后的答案').digest('hex');
    const completed = await runRepository.completeRun(context.user.userId, ids.run, {
      expectedVersion: 1,
      answer: { storage: 'PLAIN', value: '校验后的答案', sha256: answerSha256 },
      retentionExpiresAt: new Date(Date.now() + 86_400_000),
      citationsSummary: { sourceIds: sources.map((source) => source.sourceId) },
      citations: sources,
      answerFacts: {
        bundleSha256: 'c'.repeat(64),
        evidenceRoute: 'ANSWER',
        finalStatus: 'ANSWERED',
        validation: {
          outcome: 'PASS',
          issues: [],
          checkedClaimCount: 1,
          validSourceIds: sources.map((source) => source.sourceId),
          validatorProfileId: 'validator-v1',
          semanticJudge: null,
        },
        reranker: { modelId: 'fixture-reranker', revision: 'r1' },
        llm: { modelId: 'fixture-llm', revision: 'r1' },
      },
    });
    expect(completed).toMatchObject({ status: 'COMPLETED' });
    await expect(
      runRepository.getCitationPreview(context, sources[0]!.sourceId),
    ).resolves.toMatchObject({
      citationId: sources[0]!.sourceId,
      title: '查询规划与混合检索 合成制度',
    });
    await expect(
      runRepository.saveFeedback(context, completed.assistantMessageId!, {
        rating: 'NOT_HELPFUL',
        errorTypes: ['WRONG_CITATION'],
        comment: '定位不够精确',
      }),
    ).resolves.toMatchObject({
      errorTypes: ['WRONG_CITATION'],
      comment: '定位不够精确',
    });
    const report = await pool.query<{ final_status: string; citation_count: number }>(
      `SELECT report.final_status,
              (SELECT count(*)::int FROM answer_citations WHERE run_id = report.run_id) citation_count
         FROM answer_validation_reports report WHERE report.run_id = $1`,
      [ids.run],
    );
    expect(report.rows[0]).toEqual({ final_status: 'ANSWERED', citation_count: 4 });

    await pool.query(
      `UPDATE documents SET effective_to = now() - interval '1 minute' WHERE id = $1`,
      [ids.document],
    );
    await expect(
      runRepository.getCitationPreview(context, sources[0]!.sourceId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await pool.query(`UPDATE documents SET effective_to = NULL WHERE id = $1`, [ids.document]);
  });

  function command(): HydrateRetrievalCandidatesCommand {
    return {
      candidates: [
        {
          vectorId,
          manifestId: ids.manifest,
          spaceId: ids.space,
          documentId: ids.document,
          denseRank: 1,
          sparseRank: 1,
          denseScore: 0.9,
          sparseScore: 8,
          rrfScore: 0.02,
        },
      ],
      manifests: [
        {
          spaceId: ids.space,
          manifestId: ids.manifest,
          manifestVersion: 1,
          embeddingProfileId: profileId,
          embeddingModelRevision: 'r1',
          collectionName: `rag_hybrid_retrieval_${suffix}`,
          authzPolicyVersion: 1,
        },
      ],
      filter: {
        compilerVersion: 'retrieval-filter-v1',
        asOf: new Date().toISOString(),
        requireManifestMembership: true,
        requireCurrentDocumentVersion: true,
        clauses: [{ field: 'SPACE_ID', operator: 'IN', value: [ids.space] }],
      },
      currentlyAllowedSpaceIds: [ids.space],
    };
  }

  function runFixture(): RagRun {
    const now = new Date();
    return {
      id: randomUUID(),
      conversationId: randomUUID(),
      userMessageId: randomUUID(),
      assistantMessageId: null,
      status: 'RUNNING',
      optimisticVersion: 1,
      snapshot: {
        flowVersion: 'answer-v1',
        policyVersion: 'policy-v1',
        promptProfileId: 'prompt-v1',
        embeddingProfileId: profileId,
        embeddingRevision: 'r1',
        rerankerProfileId: 'reranker-v1',
        rerankerRevision: 'r1',
        llmProfileId: 'llm-v1',
        llmRevision: 'r1',
        validatorProfileId: 'validator-v1',
        manifests: [...command().manifests],
        authzVersion: 1,
        rolesSha256: 'a'.repeat(64),
        retrieval: {
          profileId: 'hybrid-v1',
          initialTopK: 40,
          finalTopK: 12,
          rrfK: 60,
          denseWeight: 0.65,
          sparseWeight: 0.35,
          maxPerDocument: 3,
          maxPerSection: 2,
          minimumResults: 3,
          maxRounds: 2,
        },
      },
      deadlineAt: new Date(now.getTime() + 60_000).toISOString(),
      eventExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
      cancelRequestedAt: null,
      failureCode: null,
      publicMessage: '正在执行',
      createdAt: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: null,
      updatedAt: now.toISOString(),
    };
  }

  async function seedAnswerRun(database: Pool, run: RagRun): Promise<void> {
    await database.query(
      `INSERT INTO conversations (id, owner_user_id, title) VALUES ($1,$2,'答案引用集成会话')`,
      [ids.conversation, context.user.userId],
    );
    await database.query(`INSERT INTO conversation_states (conversation_id) VALUES ($1)`, [
      ids.conversation,
    ]);
    await database.query(
      `INSERT INTO conversation_messages (
         id, conversation_id, role, status, content_storage, content_value,
         content_sha256, retention_expires_at
       ) VALUES ($1,$2,'USER','VISIBLE','PLAIN','报销制度是什么',$3,now() + interval '1 day')`,
      [
        ids.userMessage,
        ids.conversation,
        createHash('sha256').update('报销制度是什么').digest('hex'),
      ],
    );
    await database.query(
      `INSERT INTO rag_runs (
         id, conversation_id, owner_user_id, user_message_id, idempotency_key,
         request_sha256, status, optimistic_version, snapshot, deadline_at,
         event_expires_at, public_message, execution_roles, execution_authz_version
       ) VALUES ($1,$2,$3,$4,$5,$6,'RUNNING',1,$7::jsonb,now() + interval '1 minute',
                 now() + interval '1 day','正在执行',$8,$9)`,
      [
        ids.run,
        ids.conversation,
        context.user.userId,
        ids.userMessage,
        `answer-citation-${suffix}`,
        createHash('sha256').update('answer-citation').digest('hex'),
        JSON.stringify(run.snapshot),
        [...context.user.roles],
        context.user.authzVersion,
      ],
    );
    await database.query(`UPDATE conversation_messages SET run_id = $2 WHERE id = $1`, [
      ids.userMessage,
      ids.run,
    ]);
  }

  async function seed(database: Pool): Promise<void> {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO knowledge_spaces (id, code, name, owner_user_id)
         VALUES ($1,$2,'查询规划与混合检索 回源空间',$3)`,
        [ids.space, `hybrid-retrieval-${suffix}`, context.user.userId],
      );
      await client.query(
        `INSERT INTO documents (
           id, space_id, title, status, created_by, published_at, effective_from
         ) VALUES ($1,$2,'查询规划与混合检索 合成制度','ACTIVE',$3,now() - interval '1 day',now() - interval '1 day')`,
        [ids.document, ids.space, context.user.userId],
      );
      await client.query(
        `INSERT INTO document_versions (
           id, document_id, version_number, content_revision, status, created_by
         ) VALUES ($1,$2,1,1,'SUCCEEDED',$3)`,
        [ids.version, ids.document, context.user.userId],
      );
      await client.query(
        `INSERT INTO ingestion_jobs (
           id, document_id, document_version_id, content_revision, pipeline_version,
           status, overall_percent, public_message
         ) VALUES ($1,$2,$3,1,1,'SUCCEEDED',100,'查询规划与混合检索 合成任务完成')`,
        [jobId, ids.document, ids.version],
      );
      await client.query(
        `INSERT INTO document_parse_runs (
           id, job_id, document_version_id, content_revision, status, file_format,
           parser_profile_id, parser_revision, ocr_profile_id, ocr_revision
         ) VALUES ($1,$2,$3,1,'SUCCEEDED','TEXT','hybrid-retrieval-parser','1','hybrid-retrieval-ocr','1')`,
        [ids.parseRun, jobId, ids.version],
      );
      await client.query(
        `INSERT INTO document_blocks (
           id, parse_run_id, document_version_id, content_revision, ordinal,
           block_type, text_content, original_text, page_no, parser_name,
           parser_revision, content_sha256
         ) VALUES ($1,$2,$3,1,1,'TABLE_ROW','报销项目 | 所需凭证','报销项目 | 所需凭证',1,
                   'hybrid-retrieval-parser','1',$4)`,
        [
          tableHeaderBlockId,
          ids.parseRun,
          ids.version,
          createHash('sha256').update('报销项目 | 所需凭证').digest('hex'),
        ],
      );
      await client.query(
        `INSERT INTO knowledge_processing_runs (
           id, job_id, parse_run_id, document_version_id, content_revision, file_format,
           status, chunker_profile_id, chunker_revision, tokenizer_profile_id,
           tokenizer_revision, quality_rule_version, parent_chunk_count, child_chunk_count
         ) VALUES ($1,$2,$3,$4,1,'TEXT','SUCCEEDED','hybrid-retrieval-chunker','1','hybrid-retrieval-tokenizer','1',
                   'hybrid-retrieval-quality',1,1)`,
        [ids.processingRun, jobId, ids.parseRun, ids.version],
      );
      const contentHash = createHash('sha256')
        .update('查询规划与混合检索 合成差旅制度正文')
        .digest('hex');
      await client.query(
        `INSERT INTO knowledge_chunks (
           id, processing_run_id, document_version_id, content_revision, ordinal,
           granularity, content_type, display_content, embedding_text, token_count,
           tokenizer_profile_id, tokenizer_revision, heading_path, source_locations,
           content_sha256, dedup_status, eligible_for_index, parent_chunk_id
         ) VALUES
         ($1,$4,$5,1,1,'PARENT','PROSE','查询规划与混合检索 合成差旅制度正文','查询规划与混合检索 合成差旅制度正文',10,
          'hybrid-retrieval-tokenizer','1','["差旅制度"]','[]',$6,'UNIQUE',false,NULL),
         ($2,$4,$5,1,2,'CHILD','PROSE','查询规划与混合检索 合成差旅制度正文','查询规划与混合检索 合成差旅制度正文',10,
          'hybrid-retrieval-tokenizer','1','["差旅制度","额度"]','[]',$6,'UNIQUE',true,$1),
         ($3,$4,$5,1,3,'CHILD','PROSE','相邻的报销材料说明','相邻的报销材料说明',8,
          'hybrid-retrieval-tokenizer','1','["差旅制度","材料"]','[]',$7,'UNIQUE',true,$1)`,
        [
          parentChunkId,
          childChunkId,
          nextChunkId,
          ids.processingRun,
          ids.version,
          contentHash,
          createHash('sha256').update('相邻的报销材料说明').digest('hex'),
        ],
      );
      await client.query(
        `INSERT INTO chunk_relations (
           processing_run_id, from_chunk_id, relation_type, to_chunk_id, to_block_id, ordinal
         ) VALUES
           ($1,$2,'PARENT_CHILD',$3,NULL,0),
           ($1,$2,'NEXT',$4,NULL,0),
           ($1,$2,'TABLE_HEADER',NULL,$5,0)`,
        [ids.processingRun, childChunkId, parentChunkId, nextChunkId, tableHeaderBlockId],
      );
      await client.query(
        `INSERT INTO embedding_collection_registry (
           embedding_profile_id, compatibility_sha256, provider_profile, model_id,
           model_revision, tokenizer_revision, dense_dimension, normalize_dense,
           sparse_format_version, document_template_version, query_template_version,
           collection_name, alias_name
         ) VALUES ($1,$2,'external-ci','hybrid-retrieval-model','r1','tok1',2,true,'sparse-v1','doc-v1','query-v1',$3,$4)`,
        [
          profileId,
          '1'.repeat(64),
          `rag_hybrid_retrieval_${suffix}`,
          `rag_hybrid_retrieval_alias_${suffix}`,
        ],
      );
      await client.query(
        `INSERT INTO space_manifests (
           id, space_id, version, status, provider_profile, embedding_profile_id,
           embedding_model_id, embedding_model_revision, tokenizer_revision,
           dense_dimension, normalize_dense, sparse_format_version, collection_name,
           expected_vector_count, actual_vector_count, activated_at
         ) VALUES ($1,$2,1,'ACTIVE','external-ci',$3,'hybrid-retrieval-model','r1','tok1',2,true,
                   'sparse-v1',$4,1,1,now())`,
        [ids.manifest, ids.space, profileId, `rag_hybrid_retrieval_${suffix}`],
      );
      await client.query(
        `INSERT INTO indexing_runs (
           id, job_id, space_id, document_version_id, content_revision, embedding_revision,
           provider_profile, embedding_profile_id, embedding_model_id, embedding_model_revision,
           collection_name, manifest_id, manifest_version, status, expected_vector_count,
           embedded_count, indexed_count, completed_at
         ) VALUES ($1,$2,$3,$4,1,1,'external-ci',$5,'hybrid-retrieval-model','r1',$6,$7,1,
                   'PUBLISHED',1,1,1,now())`,
        [
          ids.indexingRun,
          jobId,
          ids.space,
          ids.version,
          profileId,
          `rag_hybrid_retrieval_${suffix}`,
          ids.manifest,
        ],
      );
      await client.query(
        `INSERT INTO embedding_facts (
           id, embedding_profile_id, content_sha256, model_id, model_revision,
           dense_vector, sparse_vector, dense_dimension
         ) VALUES ($1,$2,$3,'hybrid-retrieval-model','r1','[1,0]','{"1":1}',2)`,
        [ids.embeddingFact, profileId, contentHash],
      );
      await client.query(
        `INSERT INTO manifest_document_members (
           manifest_id, document_id, document_version_id, content_revision,
           embedding_revision, vector_count
         ) VALUES ($1,$2,$3,1,1,1)`,
        [ids.manifest, ids.document, ids.version],
      );
      await client.query(
        `INSERT INTO chunk_embedding_refs (
           indexing_run_id, manifest_id, chunk_id, embedding_fact_id, vector_id
         ) VALUES ($1,$2,$3,$4,$5)`,
        [ids.indexingRun, ids.manifest, childChunkId, ids.embeddingFact, vectorId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function cleanup(database: Pool): Promise<void> {
    await database.query(`DELETE FROM rag_runs WHERE id = $1`, [ids.run]);
    await database.query(`DELETE FROM conversation_messages WHERE conversation_id = $1`, [
      ids.conversation,
    ]);
    await database.query(`DELETE FROM conversation_states WHERE conversation_id = $1`, [
      ids.conversation,
    ]);
    await database.query(`DELETE FROM conversations WHERE id = $1`, [ids.conversation]);
    await database.query(`DELETE FROM resource_acl WHERE resource_id = $1`, [ids.space]);
    await database.query(`DELETE FROM chunk_embedding_refs WHERE indexing_run_id = $1`, [
      ids.indexingRun,
    ]);
    await database.query(`DELETE FROM manifest_document_members WHERE manifest_id = $1`, [
      ids.manifest,
    ]);
    await database.query(`DELETE FROM indexing_runs WHERE id = $1`, [ids.indexingRun]);
    await database.query(`DELETE FROM embedding_facts WHERE id = $1`, [ids.embeddingFact]);
    await database.query(`DELETE FROM space_manifests WHERE id = $1`, [ids.manifest]);
    await database.query(
      `DELETE FROM embedding_collection_registry WHERE embedding_profile_id = $1`,
      [profileId],
    );
    await database.query(`DELETE FROM chunk_relations WHERE processing_run_id = $1`, [
      ids.processingRun,
    ]);
    await database.query(`DELETE FROM knowledge_chunks WHERE processing_run_id = $1`, [
      ids.processingRun,
    ]);
    await database.query(`DELETE FROM knowledge_processing_runs WHERE id = $1`, [
      ids.processingRun,
    ]);
    await database.query(`DELETE FROM document_blocks WHERE id = $1`, [tableHeaderBlockId]);
    await database.query(`DELETE FROM document_parse_runs WHERE id = $1`, [ids.parseRun]);
    await database.query(`DELETE FROM ingestion_jobs WHERE id = $1`, [jobId]);
    await database.query(`DELETE FROM document_versions WHERE id = $1`, [ids.version]);
    await database.query(`DELETE FROM documents WHERE id = $1`, [ids.document]);
    await database.query(`DELETE FROM knowledge_spaces WHERE id = $1`, [ids.space]);
  }
});
