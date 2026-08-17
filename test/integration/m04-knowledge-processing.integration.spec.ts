/**
 * 真实 PostgreSQL 验证 M03→M04 Outbox 交接、Chunk/质量原子提交、审核乐观锁、越权拒绝和新 revision。
 * 测试数据为公开合成内容，不包含真实企业文档。
 *
 * @requirement KNO-011
 * @requirement KNO-012
 * @requirement KNO-013
 * @requirement KNO-014
 */
import {
  KnowledgeProcessingService,
  type AccessContext,
  type CreateUploadSessionCommand,
} from '@rag/application';
import { Cl100kTextTokenizer } from '@rag/chunking';
import { loadAppConfig } from '@rag/config';
import { createIsolatedObjectKey } from '@rag/ingestion-core';
import { buildDocumentBlocks } from '@rag/parser-core';
import {
  PostgresDocumentIngestionRepository,
  PostgresDocumentProcessingRepository,
  PostgresKnowledgeProcessingRepository,
  PostgresKnowledgeSpaceRepository,
} from '@rag/persistence-pg';
import { createTestUserContext } from '@rag/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const describeWithInfra = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeWithInfra('[KNO-011][KNO-012][KNO-013][KNO-014] M04 PostgreSQL transaction', () => {
  const config = loadAppConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const spaces = new PostgresKnowledgeSpaceRepository(pool);
  const ingestion = new PostgresDocumentIngestionRepository(pool);
  const parsing = new PostgresDocumentProcessingRepository(pool);
  const knowledge = new PostgresKnowledgeProcessingRepository(pool);
  const suffix = Date.now().toString(36);
  const owner: AccessContext = {
    user: createTestUserContext(`m04-owner-${suffix}`, ['KNOWLEDGE_EDITOR']),
    requestId: `m04-owner-request-${suffix}`,
    traceId: `m04-trace-${suffix}`,
  };
  const intruder: AccessContext = {
    user: createTestUserContext(`m04-intruder-${suffix}`, ['KNOWLEDGE_REVIEWER']),
    requestId: `m04-intruder-request-${suffix}`,
  };
  let spaceId = '';
  const uploadSessionIds: string[] = [];

  beforeAll(async () => {
    const space = await spaces.create(owner, {
      code: `m04-it-${suffix}`,
      name: 'M04 集成测试空间',
      description: null,
      ownerUserId: owner.user.userId,
    });
    spaceId = space.id;
  });

  afterAll(async () => {
    if (spaceId) await cleanupSpace(pool, spaceId, uploadSessionIds);
    await pool.end();
  });

  it('M03 事务产生 M04 Outbox，PASS 后只有非重复 Child 获得索引资格', async () => {
    const prepared = await prepareParsedJob('自动通过的知识正文。', null);
    const outbox = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'ingestion.knowledge_processing.requested'`,
      [prepared.jobId],
    );
    expect(outbox.rows).toHaveLength(1);

    const outcome = await runM04(prepared.jobId);
    expect(outcome).toBe('PASS');
    const job = await ingestion.getJob(owner, prepared.jobId);
    expect(job).toEqual(
      expect.objectContaining({ status: 'WAITING', currentStep: 'EMBED', overallPercent: 75 }),
    );
    const runs = await knowledge.listRuns(owner, prepared.documentVersionId);
    const detail = await knowledge.getRun(owner, runs[0]!.id);
    expect(detail?.report).toEqual(
      expect.objectContaining({
        verdict: 'PASS',
        reviewDecision: 'NOT_REQUIRED',
        eligibleForIndex: true,
      }),
    );
    const chunks = await knowledge.listChunks(owner, runs[0]!.id, {
      afterOrdinal: 0,
      limit: 100,
      granularity: 'CHILD',
    });
    expect(chunks.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ granularity: 'CHILD', eligibleForIndex: true }),
      ]),
    );
  });

  it('并发审核只有一个 expectedVersion 能成功，且无 ACL 的审核者被默认拒绝', async () => {
    const prepared = await prepareParsedJob('OCR 置信度较低的合成正文。', 0.5);
    expect(await runM04(prepared.jobId)).toBe('MANUAL_REVIEW');
    const run = (await knowledge.listRuns(owner, prepared.documentVersionId))[0]!;
    const detail = await knowledge.getRun(owner, run.id);
    expect(detail?.report.reviewDecision).toBe('PENDING');

    await expect(
      knowledge.review({
        context: intruder,
        processingRunId: run.id,
        action: 'APPROVE',
        expectedVersion: 1,
        reason: '越权审核尝试',
      }),
    ).rejects.toThrow('无权审核');

    const results = await Promise.allSettled([
      knowledge.review({
        context: owner,
        processingRunId: run.id,
        action: 'APPROVE',
        expectedVersion: 1,
        reason: '已逐页核对，允许进入索引',
      }),
      knowledge.review({
        context: owner,
        processingRunId: run.id,
        action: 'REJECT',
        expectedVersion: 1,
        reason: '并发审核的旧版本请求',
      }),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const latest = await knowledge.getRun(owner, run.id);
    expect(latest?.report.optimisticVersion).toBe(2);
    expect(['APPROVED', 'REJECTED']).toContain(latest?.report.reviewDecision);
    const reviewRows = await pool.query(
      'SELECT 1 FROM knowledge_quality_reviews WHERE report_id = $1',
      [latest?.report.id],
    );
    expect(reviewRows.rows).toHaveLength(1);
  });

  it('要求重处理原子创建新 revision 和 Outbox，旧 Chunk revision 仍保留', async () => {
    const prepared = await prepareParsedJob('需要重新识别的低置信度正文。', 0.4);
    expect(await runM04(prepared.jobId)).toBe('MANUAL_REVIEW');
    const oldRun = (await knowledge.listRuns(owner, prepared.documentVersionId))[0]!;
    const result = await knowledge.review({
      context: owner,
      processingRunId: oldRun.id,
      action: 'REQUEST_REPROCESS',
      expectedVersion: 1,
      reason: 'OCR 置信度不足，调整识别策略后重处理',
    });

    expect(result.report.reviewDecision).toBe('REPROCESS_REQUESTED');
    expect(result.reprocessJobId).toContain(':revision:2:');
    const version = await ingestion.getDocumentVersion(owner, prepared.documentVersionId);
    expect(version?.version.contentRevision).toBe(2);
    const newJob = await ingestion.getJob(owner, result.reprocessJobId!);
    expect(newJob).toEqual(
      expect.objectContaining({ status: 'QUEUED', currentStep: 'SECURITY_SCAN' }),
    );
    const oldChunks = await knowledge.listChunks(owner, oldRun.id, {
      afterOrdinal: 0,
      limit: 100,
    });
    expect(oldChunks.items.length).toBeGreaterThan(0);
    expect(oldChunks.items.every((chunk) => chunk.contentRevision === 1)).toBe(true);
  });

  async function runM04(jobId: string): Promise<string> {
    const workerId = `m04-worker-${randomUUID()}`;
    const lease = await ingestion.acquireJobLease(jobId, workerId, 120);
    expect(lease?.currentStep).toBe('CHUNK');
    const service = new KnowledgeProcessingService(
      knowledge,
      new Cl100kTextTokenizer('integration-cl100k'),
      {
        chunkerProfileId: 'integration-structure-aware',
        chunkerRevision: '1',
        qualityRuleVersion: 'integration-quality-v1',
        chunking: {
          childMaxTokens: 80,
          parentMaxTokens: 180,
          overlapTokens: 8,
          dedupMode: 'SUPPRESS',
        },
        quality: {
          minimumNonEmptyBlockRatio: 0.6,
          rejectNonEmptyBlockRatio: 0.2,
          minimumOcrConfidence: 0.75,
          maximumGarbledRatio: 0.03,
          rejectGarbledRatio: 0.15,
          maximumDuplicateRatio: 0.4,
          requireHeadingAfterBlocks: 5,
        },
      },
    );
    const outcome = await service.process(jobId, workerId);
    if (outcome === 'FAILED') {
      const failedJob = await ingestion.getJob(owner, jobId);
      throw new Error(`M04 集成处理失败：${failedJob?.publicMessage ?? 'unknown'}`);
    }
    return outcome;
  }

  async function prepareParsedJob(
    text: string,
    ocrConfidence: number | null,
  ): Promise<{ jobId: string; documentVersionId: string }> {
    const command = uploadCommand();
    uploadSessionIds.push(command.id);
    await ingestion.createUploadSession(owner, command);
    const uploadFile = await ingestion.getUploadFile(owner, command.files[0]!.id);
    const completed = await ingestion.completeUpload(owner, {
      uploadFile,
      object: {
        sizeBytes: uploadFile.sizeBytes,
        contentType: uploadFile.contentType,
        sha256: 'a'.repeat(64),
      },
    });
    const workerId = `m03-worker-${randomUUID()}`;
    await ingestion.acquireJobLease(completed.job.id, workerId, 120);
    const input = await parsing.loadInput(completed.job.id, workerId);
    const parseRun = await parsing.beginRun({
      input: input!,
      parserProfileId: 'm04-integration-parser',
      parserRevision: '1',
      ocrProfileId: 'm04-integration-ocr',
      ocrRevision: '1',
    });
    const malware = {
      verdict: 'CLEAN' as const,
      engine: 'ClamAV',
      engineRevision: 'integration',
      signatureName: null,
      scannedBytes: input!.sizeBytes,
      durationMs: 1,
    };
    await parsing.recordPreflight({
      jobId: completed.job.id,
      workerId,
      parseRunId: parseRun.id,
      fileId: input!.fileId,
      trustedSha256: 'a'.repeat(64),
      format: 'PDF',
      detectedMime: 'application/pdf',
      malware,
    });
    await parsing.startStep(completed.job.id, workerId, 'PARSE', '解析中');
    await parsing.recordSecurity({
      jobId: completed.job.id,
      workerId,
      parseRunId: parseRun.id,
      fileId: input!.fileId,
      trustedSha256: 'a'.repeat(64),
      format: 'PDF',
      detectedMime: 'application/pdf',
      verdict: 'CLEAN',
      findings: [],
      malware,
    });
    await parsing.startStep(completed.job.id, workerId, 'NORMALIZE', '标准化中');
    const candidates = [
      {
        type: 'TITLE' as const,
        text: '合成制度',
        originalText: '合成制度',
        pageNo: 1,
        sheetName: null,
        slideNo: null,
        bbox: null,
        headingLevel: 1,
        confidence: null,
        table: null,
        metadata: {},
      },
      {
        type: 'PARAGRAPH' as const,
        text,
        originalText: text,
        pageNo: 1,
        sheetName: null,
        slideNo: null,
        bbox: null,
        headingLevel: null,
        confidence: ocrConfidence,
        table: null,
        metadata: {},
      },
    ];
    const parser = {
      parserName: 'integration-parser',
      parserRevision: '1',
      protocolVersion: '1',
      blocks: candidates,
      pages: [{ pageNo: 1, textCharacterCount: text.length, textCoverage: 0.8, imageOnly: false }],
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
      durationMs: 1,
      warnings: [],
    };
    const blocks = buildDocumentBlocks({
      parseRunId: parseRun.id,
      documentVersionId: completed.documentVersion.id,
      contentRevision: 1,
      parserName: parser.parserName,
      parserRevision: parser.parserRevision,
      ...(ocrConfidence === null ? {} : { ocrEngine: 'integration-ocr', ocrRevision: '1' }),
      candidates,
    });
    await parsing.complete({
      jobId: completed.job.id,
      workerId,
      parseRunId: parseRun.id,
      parser,
      ocr: null,
      blocks,
      issues: [],
      derivedBucket: 'rag-derived',
      derivedObjectKey: `integration/${parseRun.id}/blocks.json`,
      derivedSha256: 'b'.repeat(64),
      snapshotReused: false,
      durationMs: 3,
    });
    return { jobId: completed.job.id, documentVersionId: completed.documentVersion.id };
  }

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
          originalFileName: 'm04-synthetic.pdf',
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

/** 按外键逆序清理本测试空间，绝不触碰其他开发数据。 */
async function cleanupSpace(
  pool: Pool,
  spaceId: string,
  uploadSessionIds: readonly string[],
): Promise<void> {
  await pool.query(
    `DELETE FROM knowledge_quality_reviews WHERE report_id IN (
       SELECT qr.id FROM document_quality_reports qr
       JOIN knowledge_processing_runs kr ON kr.id = qr.processing_run_id
       JOIN documents d ON d.id = (SELECT document_id FROM document_versions WHERE id = kr.document_version_id)
       WHERE d.space_id = $1
     )`,
    [spaceId],
  );
  await pool.query(
    `DELETE FROM document_quality_findings WHERE report_id IN (
       SELECT qr.id FROM document_quality_reports qr
       JOIN knowledge_processing_runs kr ON kr.id = qr.processing_run_id
       JOIN documents d ON d.id = (SELECT document_id FROM document_versions WHERE id = kr.document_version_id)
       WHERE d.space_id = $1
     )`,
    [spaceId],
  );
  for (const table of ['document_quality_reports', 'chunk_relations', 'knowledge_chunks']) {
    await pool.query(
      `DELETE FROM ${table} WHERE ${table === 'document_quality_reports' ? 'processing_run_id' : 'processing_run_id'} IN (
         SELECT kr.id FROM knowledge_processing_runs kr
         JOIN documents d ON d.id = (SELECT document_id FROM document_versions WHERE id = kr.document_version_id)
         WHERE d.space_id = $1
       )`,
      [spaceId],
    );
  }
  await pool.query(
    `DELETE FROM knowledge_processing_runs WHERE document_version_id IN (
       SELECT dv.id FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE d.space_id = $1
     )`,
    [spaceId],
  );
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
       SELECT dv.id FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE d.space_id = $1
     )`,
    [spaceId],
  );
  await pool.query(
    `DELETE FROM document_parse_runs WHERE document_version_id IN (
       SELECT dv.id FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE d.space_id = $1
     )`,
    [spaceId],
  );
  await pool.query(
    `DELETE FROM outbox_consumer_receipts WHERE event_id IN (
       SELECT id FROM outbox_events WHERE aggregate_id IN (
         SELECT id FROM ingestion_jobs WHERE document_id IN (SELECT id FROM documents WHERE space_id = $1)
       )
     )`,
    [spaceId],
  );
  await pool.query(
    `DELETE FROM outbox_events WHERE aggregate_id IN (
       SELECT id FROM ingestion_jobs WHERE document_id IN (SELECT id FROM documents WHERE space_id = $1)
     )`,
    [spaceId],
  );
  await pool.query(
    `DELETE FROM ingestion_job_events WHERE job_id IN (
       SELECT id FROM ingestion_jobs WHERE document_id IN (SELECT id FROM documents WHERE space_id = $1)
     )`,
    [spaceId],
  );
  await pool.query(
    `DELETE FROM ingestion_job_steps WHERE job_id IN (
       SELECT id FROM ingestion_jobs WHERE document_id IN (SELECT id FROM documents WHERE space_id = $1)
     )`,
    [spaceId],
  );
  await pool.query(
    `UPDATE upload_files SET ingestion_job_id = NULL, document_file_id = NULL,
      document_version_id = NULL, document_id = NULL
      WHERE upload_session_id = ANY($1::uuid[])`,
    [[...uploadSessionIds]],
  );
  await pool.query(
    "DELETE FROM audit_logs WHERE resource_type IN ('DOCUMENT','KNOWLEDGE_RUN') AND resource_id IN (SELECT id::text FROM documents WHERE space_id = $1 UNION SELECT resource_id FROM protected_resource_spaces WHERE space_id = $1)",
    [spaceId],
  );
  await pool.query(
    'DELETE FROM ingestion_jobs WHERE document_id IN (SELECT id FROM documents WHERE space_id = $1)',
    [spaceId],
  );
  await pool.query(
    `DELETE FROM document_files WHERE document_version_id IN (
       SELECT dv.id FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE d.space_id = $1
     )`,
    [spaceId],
  );
  await pool.query(
    'DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE space_id = $1)',
    [spaceId],
  );
  await pool.query('DELETE FROM protected_resource_spaces WHERE space_id = $1', [spaceId]);
  await pool.query('DELETE FROM documents WHERE space_id = $1', [spaceId]);
  if (uploadSessionIds.length > 0) {
    await pool.query('DELETE FROM upload_files WHERE upload_session_id = ANY($1::uuid[])', [
      [...uploadSessionIds],
    ]);
    await pool.query('DELETE FROM upload_sessions WHERE id = ANY($1::uuid[])', [
      [...uploadSessionIds],
    ]);
  }
  await pool.query('DELETE FROM knowledge_space_policies WHERE space_id = $1', [spaceId]);
  await pool.query('DELETE FROM resource_acl WHERE resource_id = $1', [spaceId]);
  await pool.query('DELETE FROM knowledge_spaces WHERE id = $1', [spaceId]);
}
