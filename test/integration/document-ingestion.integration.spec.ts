/**
 * 真实 PostgreSQL 验证 文档接入与任务 上传完成事务、幂等 Complete、Outbox 领取、Consumer Inbox 与 revision 重处理。
 *
 * @requirement PAR-024
 */
import type { AccessContext, CreateUploadSessionCommand } from '@rag/application';
import { loadAppConfig } from '@rag/config';
import { createIsolatedObjectKey } from '@rag/ingestion-core';
import {
  PostgresDocumentIngestionRepository,
  PostgresKnowledgeSpaceRepository,
} from '@rag/persistence-pg';
import { createTestUserContext } from '@rag/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const describeWithInfra = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeWithInfra(
  '[DOC-008][DOC-009][DOC-017][PAR-024] 文档接入与任务 PostgreSQL transaction',
  () => {
    const config = loadAppConfig(process.env);
    const pool = new Pool({ connectionString: config.databaseUrl, max: 3 });
    const spaces = new PostgresKnowledgeSpaceRepository(pool);
    const repository = new PostgresDocumentIngestionRepository(pool);
    const suffix = Date.now().toString(36);
    const context: AccessContext = {
      user: createTestUserContext(`document-ingestion-owner-${suffix}`, ['KNOWLEDGE_EDITOR']),
      requestId: `document-ingestion-integration-${suffix}`,
    };
    let spaceId = '';
    const createdUploadIds: string[] = [];

    beforeAll(async () => {
      const space = await spaces.create(context, {
        code: `document-ingestion-it-${suffix}`,
        name: '文档接入与任务 集成测试空间',
        description: null,
        ownerUserId: context.user.userId,
      });
      spaceId = space.id;
    });

    afterAll(async () => {
      if (spaceId) {
        await pool.query('DELETE FROM external_document_bindings WHERE space_id = $1', [spaceId]);
        await pool.query('DELETE FROM external_import_batches WHERE space_id = $1', [spaceId]);
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
          document_version_id = NULL, document_id = NULL
         WHERE upload_session_id = ANY($1::uuid[])`,
          [createdUploadIds],
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
        await pool.query('DELETE FROM upload_files WHERE upload_session_id = ANY($1::uuid[])', [
          createdUploadIds,
        ]);
        await pool.query('DELETE FROM upload_sessions WHERE space_id = $1', [spaceId]);
        await pool.query('DELETE FROM knowledge_space_policies WHERE space_id = $1', [spaceId]);
        await pool.query('DELETE FROM resource_acl WHERE resource_id = $1', [spaceId]);
        await pool.query('DELETE FROM knowledge_spaces WHERE id = $1', [spaceId]);
      }
      await pool.end();
    });

    it('事务失败不留半成品，重试后重复 Complete 返回同一事实', async () => {
      const command = uploadCommand('工资制度.pdf');
      createdUploadIds.push(command.id);
      await repository.createUploadSession(context, command);
      const uploadFile = await repository.getUploadFile(context, command.files[0]!.id);

      await expect(
        repository.completeUpload(context, {
          uploadFile,
          object: {
            sizeBytes: uploadFile.sizeBytes,
            contentType: uploadFile.contentType,
            sha256: 'invalid-database-hash',
          },
        }),
      ).rejects.toBeDefined();
      const afterRollback = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM documents WHERE space_id = $1',
        [spaceId],
      );
      expect(afterRollback.rows[0]?.count).toBe('0');

      const first = await repository.completeUpload(context, {
        uploadFile,
        object: {
          sizeBytes: uploadFile.sizeBytes,
          contentType: uploadFile.contentType,
          etag: 'etag-1',
          sha256: 'a'.repeat(64),
        },
      });
      const repeated = await repository.completeUpload(context, {
        uploadFile,
        object: {
          sizeBytes: uploadFile.sizeBytes,
          contentType: uploadFile.contentType,
          etag: 'etag-1',
          sha256: 'a'.repeat(64),
        },
      });
      expect(repeated.document.id).toBe(first.document.id);
      expect(repeated.job.id).toBe(first.job.id);
      expect(first.job.steps).toHaveLength(10);

      const facts = await pool.query<{ documents: string; jobs: string; outbox: string }>(
        `SELECT
         (SELECT count(*) FROM documents WHERE space_id = $1)::text AS documents,
         (SELECT count(*) FROM ingestion_jobs WHERE document_id = $2)::text AS jobs,
         (SELECT count(*) FROM outbox_events WHERE aggregate_id = $3)::text AS outbox`,
        [spaceId, first.document.id, first.job.id],
      );
      expect(facts.rows[0]).toEqual({ documents: '1', jobs: '1', outbox: '1' });
    });

    it('[OPT-012] 同一会话两个文件并发完成时都创建独立文档和 Outbox', async () => {
      const uploadId = randomUUID();
      const fileIds = [randomUUID(), randomUUID()];
      const command: CreateUploadSessionCommand = {
        id: uploadId,
        spaceId,
        expiresAt: new Date(Date.now() + 60_000),
        files: fileIds.map((fileId, index) => ({
          id: fileId,
          clientFileId: `parallel-${index}`,
          originalFileName: `并发制度-${index}.pdf`,
          strategy: 'SINGLE' as const,
          bucket: 'rag-quarantine',
          objectKey: createIsolatedObjectKey(spaceId, uploadId, fileId),
          sizeBytes: 1024 + index,
          contentType: 'application/pdf',
          partSizeBytes: 8 * 1024 * 1024,
          partCount: 1,
        })),
      };
      createdUploadIds.push(uploadId);
      await repository.createUploadSession(context, command);
      const uploadFiles = await Promise.all(
        fileIds.map((fileId) => repository.getUploadFile(context, fileId)),
      );

      const completed = await Promise.all(
        uploadFiles.map((uploadFile, index) =>
          repository.completeUpload(context, {
            uploadFile,
            object: {
              sizeBytes: uploadFile.sizeBytes,
              contentType: uploadFile.contentType,
              etag: `parallel-etag-${index}`,
              sha256: String(index + 1).repeat(64),
            },
          }),
        ),
      );

      expect(new Set(completed.map((item) => item.document.id)).size).toBe(2);
      expect(new Set(completed.map((item) => item.job.id)).size).toBe(2);
      await expect(repository.getUploadSession(context, uploadId)).resolves.toEqual(
        expect.objectContaining({ status: 'COMPLETED' }),
      );
      const facts = await pool.query<{ documents: string; jobs: string; outbox: string }>(
        `SELECT
         (SELECT count(*) FROM documents WHERE id = ANY($1::uuid[]))::text AS documents,
         (SELECT count(*) FROM ingestion_jobs WHERE id = ANY($2::text[]))::text AS jobs,
         (SELECT count(*) FROM outbox_events WHERE aggregate_id = ANY($2::text[]))::text AS outbox`,
        [completed.map((item) => item.document.id), completed.map((item) => item.job.id)],
      );
      expect(facts.rows[0]).toEqual({ documents: '2', jobs: '2', outbox: '2' });
    });

    it('[OPT-013] 外部文档同内容重试复用事实，内容变化只创建新版本', async () => {
      const sourceId = 'finance-system';
      const externalDocumentId = `travel-policy-${suffix}`;
      const firstCommand = externalUploadCommand(
        '外部差旅制度-v1.pdf',
        sourceId,
        externalDocumentId,
        'a'.repeat(64),
      );
      createdUploadIds.push(firstCommand.id);
      await repository.createUploadSession(context, firstCommand);
      const firstFile = await repository.getUploadFile(context, firstCommand.files[0]!.id);
      const first = await repository.completeUpload(context, {
        uploadFile: firstFile,
        object: {
          sizeBytes: firstFile.sizeBytes,
          contentType: firstFile.contentType,
          etag: 'external-v1',
          sha256: 'a'.repeat(64),
        },
      });

      const sameCommand = externalUploadCommand(
        '外部差旅制度-v1-copy.pdf',
        sourceId,
        externalDocumentId,
        'a'.repeat(64),
      );
      createdUploadIds.push(sameCommand.id);
      await repository.createUploadSession(context, sameCommand);
      const sameFile = await repository.getUploadFile(context, sameCommand.files[0]!.id);
      const replayed = await repository.completeUpload(context, {
        uploadFile: sameFile,
        object: {
          sizeBytes: sameFile.sizeBytes,
          contentType: sameFile.contentType,
          etag: 'external-v1-copy',
          sha256: 'a'.repeat(64),
        },
      });
      expect(replayed.document.id).toBe(first.document.id);
      expect(replayed.documentVersion.id).toBe(first.documentVersion.id);
      expect(replayed.job.id).toBe(first.job.id);

      const changedCommand = externalUploadCommand(
        '外部差旅制度-v2.pdf',
        sourceId,
        externalDocumentId,
        'b'.repeat(64),
      );
      createdUploadIds.push(changedCommand.id);
      await repository.createUploadSession(context, changedCommand);
      const changedFile = await repository.getUploadFile(context, changedCommand.files[0]!.id);
      const changed = await repository.completeUpload(context, {
        uploadFile: changedFile,
        object: {
          sizeBytes: changedFile.sizeBytes,
          contentType: changedFile.contentType,
          etag: 'external-v2',
          sha256: 'b'.repeat(64),
        },
      });
      expect(changed.document.id).toBe(first.document.id);
      expect(changed.documentVersion.id).not.toBe(first.documentVersion.id);
      expect(changed.documentVersion.versionNumber).toBe(2);
      const versions = await pool.query<{ version_number: number }>(
        'SELECT version_number FROM document_versions WHERE document_id = $1 ORDER BY version_number',
        [first.document.id],
      );
      expect(versions.rows.map((row) => row.version_number)).toEqual([1, 2]);
    });

    it('Outbox 领取有 lease，Inbox 重投只写一次收据但任务仍可领取', async () => {
      const claimed = await repository.claimOutboxBatch(`publisher-${suffix}`, 10, 30);
      expect(claimed).toHaveLength(1);
      await expect(repository.claimOutboxBatch('another-publisher', 10, 30)).resolves.toHaveLength(
        0,
      );

      const event = claimed[0]!;
      await expect(
        repository.consumeQueuedIngestion(
          'ingestion-worker:document-ingestion',
          event.id,
          event.aggregateId,
        ),
      ).resolves.toBe(true);
      await expect(
        repository.consumeQueuedIngestion(
          'ingestion-worker:document-ingestion',
          event.id,
          event.aggregateId,
        ),
      ).resolves.toBe(false);
      await repository.markOutboxPublished(event.id);

      const job = await repository.getJob(context, event.aggregateId);
      expect(job?.status).toBe('QUEUED');
      expect(job?.steps[0]?.status).toBe('QUEUED');
      const events = await repository.listJobEvents(context, event.aggregateId, 0, 100);
      expect(events.items.map((item) => item.eventType)).toEqual([
        'ingestion.queued',
        'ingestion.message_received',
      ]);

      const cancelled = await repository.cancelJob(
        context,
        event.aggregateId,
        '为重处理测试进入终态',
      );
      const versionDetail = await repository.getDocumentVersion(
        context,
        cancelled.documentVersionId,
      );
      const reprocessed = await repository.reprocessDocumentVersion(
        context,
        cancelled.documentVersionId,
        versionDetail!.version.optimisticVersion,
        '升级解析实现',
      );
      expect(reprocessed.contentRevision).toBe(2);
      expect(reprocessed.id).not.toBe(cancelled.id);
      const historicalJobs = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ingestion_jobs WHERE document_version_id = $1`,
        [cancelled.documentVersionId],
      );
      expect(historicalJobs.rows[0]?.count).toBe('2');
    });

    it('Heartbeat 只接受 lease owner 的真实单位进度，过期后安全重排队', async () => {
      const command = uploadCommand('lease-test.pdf');
      createdUploadIds.push(command.id);
      await repository.createUploadSession(context, command);
      const uploadFile = await repository.getUploadFile(context, command.files[0]!.id);
      const completed = await repository.completeUpload(context, {
        uploadFile,
        object: {
          sizeBytes: uploadFile.sizeBytes,
          contentType: uploadFile.contentType,
          etag: 'lease-etag',
        },
      });
      const workerId = `worker-${suffix}`;
      await expect(repository.acquireJobLease(completed.job.id, workerId, 120)).resolves.toEqual(
        expect.objectContaining({ status: 'RUNNING' }),
      );
      const heartbeat = await repository.heartbeatJob(
        completed.job.id,
        workerId,
        {
          stepName: 'SECURITY_SCAN',
          processedUnits: 5,
          totalUnits: 10,
          publicMessage: '已扫描 5/10 个检查单元',
        },
        120,
      );
      expect(heartbeat?.steps[0]).toEqual(
        expect.objectContaining({ stagePercent: 50, overallPercent: 4 }),
      );
      await expect(
        repository.heartbeatJob(
          completed.job.id,
          'other-worker',
          {
            stepName: 'SECURITY_SCAN',
            processedUnits: 10,
            totalUnits: 10,
            publicMessage: '越权更新',
          },
          120,
        ),
      ).resolves.toBeUndefined();

      await pool.query(
        `UPDATE ingestion_jobs SET lease_expires_at = now() - interval '1 second'
        WHERE id = $1`,
        [completed.job.id],
      );
      await expect(repository.recoverExpiredLeases(new Date(), 3)).resolves.toBe(1);
      await expect(repository.getJob(context, completed.job.id)).resolves.toEqual(
        expect.objectContaining({ status: 'QUEUED', attempt: 2 }),
      );
    });

    function uploadCommand(fileName: string): CreateUploadSessionCommand {
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
            originalFileName: fileName,
            strategy: 'SINGLE',
            bucket: 'rag-quarantine',
            objectKey: createIsolatedObjectKey(spaceId, uploadId, fileId),
            sizeBytes: 200 * 1024 * 1024,
            contentType: 'application/pdf',
            partSizeBytes: 8 * 1024 * 1024,
            partCount: 1,
          },
        ],
      };
    }

    /** 构造带长期外部身份和内容 Hash 的单文件批次。 */
    function externalUploadCommand(
      fileName: string,
      externalSourceId: string,
      externalDocumentId: string,
      sha256: string,
    ): CreateUploadSessionCommand {
      const command = uploadCommand(fileName);
      return {
        ...command,
        externalBatch: {
          idempotencyKey: `idem-${command.id}`,
          requestSha256: sha256,
        },
        files: command.files.map((file) => ({
          ...file,
          sha256,
          externalSourceId,
          externalDocumentId,
        })),
      };
    }
  },
);
