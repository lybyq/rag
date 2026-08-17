/** 真实 PostgreSQL 验证 M03 lease fencing、Block 原子提交和管理员查询。 */
import type { AccessContext, CreateUploadSessionCommand } from '@rag/application';
import { loadAppConfig } from '@rag/config';
import { createIsolatedObjectKey } from '@rag/ingestion-core';
import { buildDocumentBlocks } from '@rag/parser-core';
import {
  PostgresDocumentIngestionRepository,
  PostgresDocumentProcessingRepository,
  PostgresKnowledgeSpaceRepository,
} from '@rag/persistence-pg';
import { createTestUserContext } from '@rag/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const describeWithInfra = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeWithInfra('[PAR-012][PAR-013][PAR-015] M03 PostgreSQL transaction', () => {
  const config = loadAppConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 3 });
  const spaces = new PostgresKnowledgeSpaceRepository(pool);
  const ingestion = new PostgresDocumentIngestionRepository(pool);
  const processing = new PostgresDocumentProcessingRepository(pool);
  const suffix = Date.now().toString(36);
  const context: AccessContext = {
    user: createTestUserContext(`m03-owner-${suffix}`, ['KNOWLEDGE_EDITOR']),
    requestId: `m03-integration-${suffix}`,
  };
  let spaceId = '';
  let uploadSessionId = '';

  beforeAll(async () => {
    const space = await spaces.create(context, {
      code: `m03-it-${suffix}`,
      name: 'M03 集成测试空间',
      description: null,
      ownerUserId: context.user.userId,
    });
    spaceId = space.id;
  });

  afterAll(async () => {
    if (spaceId) {
      await pool.query(
        `DELETE FROM document_parse_issues WHERE parse_run_id IN (
           SELECT pr.id FROM document_parse_runs pr
           JOIN documents d ON d.id = (SELECT document_id FROM document_versions WHERE id = pr.document_version_id)
           WHERE d.space_id = $1
         )`,
        [spaceId],
      );
      await pool.query(
        `DELETE FROM document_blocks WHERE document_version_id IN (
           SELECT dv.id FROM document_versions dv JOIN documents d ON d.id = dv.document_id
           WHERE d.space_id = $1
         )`,
        [spaceId],
      );
      await pool.query(
        `DELETE FROM document_parse_runs WHERE document_version_id IN (
           SELECT dv.id FROM document_versions dv JOIN documents d ON d.id = dv.document_id
           WHERE d.space_id = $1
         )`,
        [spaceId],
      );
      await pool.query(
        `DELETE FROM outbox_consumer_receipts WHERE event_id IN (
           SELECT id FROM outbox_events WHERE aggregate_id IN (
             SELECT id FROM ingestion_jobs WHERE document_id IN (
               SELECT id FROM documents WHERE space_id = $1
             )
           )
         )`,
        [spaceId],
      );
      await pool.query(
        `DELETE FROM outbox_events WHERE aggregate_id IN (
           SELECT id FROM ingestion_jobs WHERE document_id IN (
             SELECT id FROM documents WHERE space_id = $1
           )
         )`,
        [spaceId],
      );
      await pool.query(
        `DELETE FROM ingestion_job_events WHERE job_id IN (
           SELECT id FROM ingestion_jobs WHERE document_id IN (
             SELECT id FROM documents WHERE space_id = $1
           )
         )`,
        [spaceId],
      );
      await pool.query(
        `DELETE FROM ingestion_job_steps WHERE job_id IN (
           SELECT id FROM ingestion_jobs WHERE document_id IN (
             SELECT id FROM documents WHERE space_id = $1
           )
         )`,
        [spaceId],
      );
      await pool.query(
        `UPDATE upload_files SET ingestion_job_id = NULL, document_file_id = NULL,
          document_version_id = NULL, document_id = NULL WHERE upload_session_id = $1`,
        [uploadSessionId],
      );
      await pool.query(
        `DELETE FROM audit_logs WHERE resource_type = 'DOCUMENT'
          AND resource_id IN (SELECT id::text FROM documents WHERE space_id = $1)`,
        [spaceId],
      );
      await pool.query(
        `DELETE FROM ingestion_jobs WHERE document_id IN (
           SELECT id FROM documents WHERE space_id = $1
         )`,
        [spaceId],
      );
      await pool.query(
        `DELETE FROM document_files WHERE document_version_id IN (
           SELECT dv.id FROM document_versions dv JOIN documents d ON d.id = dv.document_id
           WHERE d.space_id = $1
         )`,
        [spaceId],
      );
      await pool.query(
        `DELETE FROM document_versions WHERE document_id IN (
           SELECT id FROM documents WHERE space_id = $1
         )`,
        [spaceId],
      );
      await pool.query('DELETE FROM protected_resource_spaces WHERE space_id = $1', [spaceId]);
      await pool.query('DELETE FROM documents WHERE space_id = $1', [spaceId]);
      await pool.query('DELETE FROM upload_files WHERE upload_session_id = $1', [uploadSessionId]);
      await pool.query('DELETE FROM upload_sessions WHERE id = $1', [uploadSessionId]);
      await pool.query('DELETE FROM knowledge_space_policies WHERE space_id = $1', [spaceId]);
      await pool.query('DELETE FROM resource_acl WHERE resource_id = $1', [spaceId]);
      await pool.query('DELETE FROM knowledge_spaces WHERE id = $1', [spaceId]);
    }
    await pool.end();
  });

  it('只有 lease owner 能原子写入 Block，完成后通过 Outbox 排队 M04 CHUNK', async () => {
    const command = uploadCommand();
    uploadSessionId = command.id;
    await ingestion.createUploadSession(context, command);
    const uploadFile = await ingestion.getUploadFile(context, command.files[0]!.id);
    const completed = await ingestion.completeUpload(context, {
      uploadFile,
      object: {
        sizeBytes: uploadFile.sizeBytes,
        contentType: uploadFile.contentType,
        sha256: 'a'.repeat(64),
      },
    });
    const workerId = `m03-worker-${suffix}`;
    await ingestion.acquireJobLease(completed.job.id, workerId, 120);
    const input = await processing.loadInput(completed.job.id, workerId);
    expect(input).toBeDefined();
    const run = await processing.beginRun({
      input: input!,
      parserProfileId: 'parser-golden',
      parserRevision: 'parser-r1',
      ocrProfileId: 'ocr-golden',
      ocrRevision: 'ocr-r1',
    });
    await processing.recordPreflight({
      jobId: completed.job.id,
      workerId,
      parseRunId: run.id,
      fileId: input!.fileId,
      trustedSha256: 'a'.repeat(64),
      format: 'PDF',
      detectedMime: 'application/pdf',
      malware: {
        verdict: 'CLEAN',
        engine: 'ClamAV',
        engineRevision: 'ClamAV 1.4.3/0/test',
        signatureName: null,
        scannedBytes: input!.sizeBytes,
        durationMs: 10,
      },
    });
    await processing.startStep(completed.job.id, workerId, 'PARSE', '解析中');
    await processing.recordSecurity({
      jobId: completed.job.id,
      workerId,
      parseRunId: run.id,
      fileId: input!.fileId,
      trustedSha256: 'a'.repeat(64),
      format: 'PDF',
      detectedMime: 'application/pdf',
      verdict: 'CLEAN',
      findings: [],
      malware: {
        verdict: 'CLEAN',
        engine: 'ClamAV',
        engineRevision: '1.4.3',
        signatureName: null,
        scannedBytes: input!.sizeBytes,
        durationMs: 12,
      },
    });
    await processing.startStep(completed.job.id, workerId, 'NORMALIZE', '标准化中');
    const parser = {
      parserName: 'golden-parser',
      parserRevision: 'parser-r1',
      protocolVersion: '1',
      blocks: [
        {
          type: 'PARAGRAPH' as const,
          text: '统一 Block',
          originalText: '统一  Block',
          pageNo: 1,
          sheetName: null,
          slideNo: null,
          bbox: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.2 },
          headingLevel: null,
          confidence: null,
          table: null,
          metadata: {},
        },
      ],
      pages: [{ pageNo: 1, textCharacterCount: 8, textCoverage: 0.5, imageOnly: false }],
      inspection: {
        encrypted: false,
        hasMacros: false,
        embeddedObjectCount: 0,
        externalLinkCount: 0,
        archiveDepth: null,
        compressedSizeBytes: null,
        uncompressedSizeBytes: null,
        pageCount: 1,
        totalPixels: null,
        tableCellCount: 0,
      },
      durationMs: 20,
      warnings: [],
    };
    const blocks = buildDocumentBlocks({
      parseRunId: run.id,
      documentVersionId: completed.documentVersion.id,
      contentRevision: 1,
      parserName: parser.parserName,
      parserRevision: parser.parserRevision,
      candidates: parser.blocks,
    });
    await expect(
      processing.complete({
        jobId: completed.job.id,
        workerId: 'wrong-worker',
        parseRunId: run.id,
        parser,
        ocr: null,
        blocks,
        issues: [],
        derivedBucket: 'rag-derived',
        derivedObjectKey: 'derived/golden/blocks.json',
        derivedSha256: 'b'.repeat(64),
        snapshotReused: false,
        durationMs: 50,
      }),
    ).rejects.toThrow('租约已失效');
    await processing.complete({
      jobId: completed.job.id,
      workerId,
      parseRunId: run.id,
      parser,
      ocr: null,
      blocks,
      issues: [],
      derivedBucket: 'rag-derived',
      derivedObjectKey: 'derived/golden/blocks.json',
      derivedSha256: 'b'.repeat(64),
      snapshotReused: false,
      durationMs: 50,
    });

    await expect(ingestion.getJob(context, completed.job.id)).resolves.toEqual(
      expect.objectContaining({ status: 'QUEUED', currentStep: 'CHUNK', overallPercent: 50 }),
    );
    const runs = await processing.listRuns(context, completed.documentVersion.id);
    expect(runs[0]).toEqual(expect.objectContaining({ status: 'SUCCEEDED', blockCount: 1 }));
    const page = await processing.listBlocks(context, run.id, { afterOrdinal: 0, limit: 100 });
    expect(page.items[0]).toEqual(
      expect.objectContaining({ text: '统一 Block', originalText: '统一  Block', pageNo: 1 }),
    );
  });

  function uploadCommand(): CreateUploadSessionCommand {
    const uploadId = randomUUID();
    const fileId = randomUUID();
    return {
      id: uploadId,
      spaceId,
      expiresAt: new Date(Date.now() + 60_000),
      files: [
        {
          id: fileId,
          clientFileId: `client-${fileId}`,
          originalFileName: 'm03-golden.pdf',
          strategy: 'SINGLE',
          bucket: 'rag-quarantine',
          objectKey: createIsolatedObjectKey(spaceId, uploadId, fileId),
          sizeBytes: 1_024,
          contentType: 'application/pdf',
          partSizeBytes: 8 * 1024 * 1024,
          partCount: 1,
        },
      ],
    };
  }
});
