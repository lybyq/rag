/**
 * M07 PostgreSQL 批量回源集成门禁。
 *
 * 使用真实迁移后的 PostgreSQL 验证 vectorId 单批关联、Manifest 成员/版本、文档状态、发布时间、
 * 生效窗口和当前允许空间的 fail-closed 复核。测试不连接公网模型或 Milvus。
 *
 * @requirement RET-006
 * @requirement RET-007
 * @requirement RET-012
 * @requirement RET-013
 */
import type { AccessContext, HydrateRetrievalCandidatesCommand } from '@rag/application';
import { loadAppConfig } from '@rag/config';
import { PostgresRetrievalRepository } from '@rag/persistence-pg';
import { createTestUserContext } from '@rag/testing';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const describeWithInfra = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeWithInfra('[RET-012][RET-013] M07 PostgreSQL retrieval source', () => {
  const config = loadAppConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const repository = new PostgresRetrievalRepository(pool);
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
  };
  const jobId = `m07-source-${suffix}`;
  const profileId = `m07-profile-${suffix}`;
  const parentChunkId = `m07-parent-${suffix}`;
  const childChunkId = `m07-child-${suffix}`;
  const vectorId = createHash('sha256')
    .update(`${ids.manifest}:${childChunkId}:${profileId}`)
    .digest('hex');
  const context: AccessContext = {
    user: createTestUserContext(`m07-user-${suffix}`, ['SYSTEM_ADMIN']),
    requestId: `m07-request-${suffix}`,
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
        displayContent: 'M07 合成差旅制度正文',
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
      user: createTestUserContext(`m07-reader-${suffix}`, ['KNOWLEDGE_READER']),
      requestId: `m07-reader-request-${suffix}`,
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
          collectionName: `rag_m07_${suffix}`,
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

  async function seed(database: Pool): Promise<void> {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO knowledge_spaces (id, code, name, owner_user_id)
         VALUES ($1,$2,'M07 回源空间',$3)`,
        [ids.space, `m07-${suffix}`, context.user.userId],
      );
      await client.query(
        `INSERT INTO documents (
           id, space_id, title, status, created_by, published_at, effective_from
         ) VALUES ($1,$2,'M07 合成制度','ACTIVE',$3,now() - interval '1 day',now() - interval '1 day')`,
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
         ) VALUES ($1,$2,$3,1,1,'SUCCEEDED',100,'M07 合成任务完成')`,
        [jobId, ids.document, ids.version],
      );
      await client.query(
        `INSERT INTO document_parse_runs (
           id, job_id, document_version_id, content_revision, status, file_format,
           parser_profile_id, parser_revision, ocr_profile_id, ocr_revision
         ) VALUES ($1,$2,$3,1,'SUCCEEDED','TEXT','m07-parser','1','m07-ocr','1')`,
        [ids.parseRun, jobId, ids.version],
      );
      await client.query(
        `INSERT INTO knowledge_processing_runs (
           id, job_id, parse_run_id, document_version_id, content_revision, file_format,
           status, chunker_profile_id, chunker_revision, tokenizer_profile_id,
           tokenizer_revision, quality_rule_version, parent_chunk_count, child_chunk_count
         ) VALUES ($1,$2,$3,$4,1,'TEXT','SUCCEEDED','m07-chunker','1','m07-tokenizer','1',
                   'm07-quality',1,1)`,
        [ids.processingRun, jobId, ids.parseRun, ids.version],
      );
      const contentHash = createHash('sha256').update('M07 合成差旅制度正文').digest('hex');
      await client.query(
        `INSERT INTO knowledge_chunks (
           id, processing_run_id, document_version_id, content_revision, ordinal,
           granularity, content_type, display_content, embedding_text, token_count,
           tokenizer_profile_id, tokenizer_revision, heading_path, source_locations,
           content_sha256, dedup_status, eligible_for_index, parent_chunk_id
         ) VALUES
         ($1,$3,$4,1,1,'PARENT','PROSE','M07 合成差旅制度正文','M07 合成差旅制度正文',10,
          'm07-tokenizer','1','["差旅制度"]','[]',$5,'UNIQUE',false,NULL),
         ($2,$3,$4,1,2,'CHILD','PROSE','M07 合成差旅制度正文','M07 合成差旅制度正文',10,
          'm07-tokenizer','1','["差旅制度","额度"]','[]',$5,'UNIQUE',true,$1)`,
        [parentChunkId, childChunkId, ids.processingRun, ids.version, contentHash],
      );
      await client.query(
        `INSERT INTO embedding_collection_registry (
           embedding_profile_id, compatibility_sha256, provider_profile, model_id,
           model_revision, tokenizer_revision, dense_dimension, normalize_dense,
           sparse_format_version, document_template_version, query_template_version,
           collection_name, alias_name
         ) VALUES ($1,$2,'external-ci','m07-model','r1','tok1',2,true,'sparse-v1','doc-v1','query-v1',$3,$4)`,
        [profileId, '1'.repeat(64), `rag_m07_${suffix}`, `rag_m07_alias_${suffix}`],
      );
      await client.query(
        `INSERT INTO space_manifests (
           id, space_id, version, status, provider_profile, embedding_profile_id,
           embedding_model_id, embedding_model_revision, tokenizer_revision,
           dense_dimension, normalize_dense, sparse_format_version, collection_name,
           expected_vector_count, actual_vector_count, activated_at
         ) VALUES ($1,$2,1,'ACTIVE','external-ci',$3,'m07-model','r1','tok1',2,true,
                   'sparse-v1',$4,1,1,now())`,
        [ids.manifest, ids.space, profileId, `rag_m07_${suffix}`],
      );
      await client.query(
        `INSERT INTO indexing_runs (
           id, job_id, space_id, document_version_id, content_revision, embedding_revision,
           provider_profile, embedding_profile_id, embedding_model_id, embedding_model_revision,
           collection_name, manifest_id, manifest_version, status, expected_vector_count,
           embedded_count, indexed_count, completed_at
         ) VALUES ($1,$2,$3,$4,1,1,'external-ci',$5,'m07-model','r1',$6,$7,1,
                   'PUBLISHED',1,1,1,now())`,
        [
          ids.indexingRun,
          jobId,
          ids.space,
          ids.version,
          profileId,
          `rag_m07_${suffix}`,
          ids.manifest,
        ],
      );
      await client.query(
        `INSERT INTO embedding_facts (
           id, embedding_profile_id, content_sha256, model_id, model_revision,
           dense_vector, sparse_vector, dense_dimension
         ) VALUES ($1,$2,$3,'m07-model','r1','[1,0]','{"1":1}',2)`,
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
    await database.query(`DELETE FROM knowledge_chunks WHERE processing_run_id = $1`, [
      ids.processingRun,
    ]);
    await database.query(`DELETE FROM knowledge_processing_runs WHERE id = $1`, [
      ids.processingRun,
    ]);
    await database.query(`DELETE FROM document_parse_runs WHERE id = $1`, [ids.parseRun]);
    await database.query(`DELETE FROM ingestion_jobs WHERE id = $1`, [jobId]);
    await database.query(`DELETE FROM document_versions WHERE id = $1`, [ids.version]);
    await database.query(`DELETE FROM documents WHERE id = $1`, [ids.document]);
    await database.query(`DELETE FROM knowledge_spaces WHERE id = $1`, [ids.space]);
  }
});
