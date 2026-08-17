/**
 * M02 PostgreSQL 文档接入 Repository。
 * 上传完成用一个事务写入 Document、Version、File、Job、Steps、事件和 Outbox。
 *
 * @requirement DOC-002
 * @requirement DOC-008
 * @requirement DOC-009
 * @requirement DOC-011
 * @requirement DOC-015
 * @requirement DOC-016
 * @requirement DOC-017
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ApplicationError,
  type AccessContext,
  type CompleteUploadCommand,
  type CursorResult,
  type DocumentDetail,
  type DocumentIngestionRepository,
  type DocumentVersionDetail,
  type JobEventPage,
  type UploadFileRecord,
  type CreateUploadSessionCommand,
} from '@rag/application';
import {
  CompleteUploadResultSchema,
  DocumentFileSchema,
  DocumentSchema,
  DocumentVersionSchema,
  IngestionJobEventSchema,
  IngestionJobSchema,
  OutboxEventSchema,
  UploadSessionSchema,
  type CompleteUploadResult,
  type Document,
  type DocumentFile,
  type DocumentVersion,
  type IngestionExecutionStatus,
  type IngestionJob,
  type IngestionJobEvent,
  type IngestionJobStep,
  type IngestionStepName,
  type ListDocumentsQuery,
  type ListIngestionJobsQuery,
  type OutboxEvent,
  type UploadSession,
} from '@rag/contracts';
import {
  INGESTION_STEP_ORDER,
  INGESTION_STEP_WEIGHTS,
  calculateOverallPercent,
  calculateStagePercent,
  createIngestionJobId,
  createIngestionStepId,
} from '@rag/ingestion-core';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

interface DocumentRow extends QueryResultRow {
  id: string;
  space_id: string;
  title: string;
  status: 'ACTIVE' | 'ARCHIVED';
  latest_version_number: number;
  version: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface VersionRow extends QueryResultRow {
  id: string;
  document_id: string;
  version_number: number;
  content_revision: number;
  status: DocumentVersion['status'];
  optimistic_version: number;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface FileRow extends QueryResultRow {
  id: string;
  document_version_id: string;
  original_file_name: string;
  bucket: string;
  object_key: string;
  size_bytes: string | number;
  content_type: string;
  etag: string | null;
  sha256: string | null;
  created_at: Date | string;
}

interface JobRow extends QueryResultRow {
  id: string;
  document_id: string;
  document_version_id: string;
  content_revision: number;
  pipeline_version: number;
  status: IngestionExecutionStatus;
  current_step: IngestionStepName | null;
  overall_percent: string | number;
  public_message: string | null;
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  heartbeat_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StepRow extends QueryResultRow {
  id: string;
  job_id: string;
  step_name: IngestionStepName;
  step_version: number;
  position: number;
  status: IngestionExecutionStatus;
  weight_percent: string | number;
  processed_units: string | number;
  total_units: string | number | null;
  stage_percent: string | number | null;
  overall_percent: string | number;
  public_message: string | null;
  attempt: number;
  started_at: Date | string | null;
  heartbeat_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface UploadRow extends QueryResultRow {
  session_id: string;
  space_id: string;
  session_status: UploadFileRecord['sessionStatus'];
  expires_at: Date | string;
  session_created_at: Date | string;
  file_id: string;
  client_file_id: string;
  original_file_name: string;
  strategy: UploadFileRecord['strategy'];
  bucket: string;
  object_key: string;
  size_bytes: string | number;
  content_type: string;
  expected_sha256: string | null;
  multipart_upload_id: string | null;
  part_size_bytes: number;
  part_count: number;
  file_status: UploadFileRecord['fileStatus'];
}

interface EventRow extends QueryResultRow {
  id: string | number;
  job_id: string;
  event_type: string;
  data: Record<string, unknown>;
  occurred_at: Date | string;
}

interface OutboxRow extends QueryResultRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
  published_at: Date | string | null;
  attempts: number;
}

/** PostgreSQL bigint/numeric 驱动默认返回字符串，映射边界统一转换。 */
function numeric(value: string | number): number {
  return Number(value);
}

/** 所有数据库时间统一输出 UTC ISO 字符串。 */
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function mapDocument(row: DocumentRow): Document {
  return DocumentSchema.parse({
    id: row.id,
    spaceId: row.space_id,
    title: row.title,
    status: row.status,
    latestVersionNumber: row.latest_version_number,
    version: row.version,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapVersion(row: VersionRow): DocumentVersion {
  return DocumentVersionSchema.parse({
    id: row.id,
    documentId: row.document_id,
    versionNumber: row.version_number,
    contentRevision: row.content_revision,
    status: row.status,
    optimisticVersion: row.optimistic_version,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapFile(row: FileRow): DocumentFile {
  return DocumentFileSchema.parse({
    id: row.id,
    documentVersionId: row.document_version_id,
    originalFileName: row.original_file_name,
    bucket: row.bucket,
    objectKey: row.object_key,
    sizeBytes: numeric(row.size_bytes),
    contentType: row.content_type,
    etag: row.etag,
    sha256: row.sha256,
    createdAt: iso(row.created_at),
  });
}

function mapStep(row: StepRow): IngestionJobStep {
  return {
    id: row.id,
    jobId: row.job_id,
    name: row.step_name,
    stepVersion: row.step_version,
    status: row.status,
    weightPercent: numeric(row.weight_percent),
    processedUnits: numeric(row.processed_units),
    totalUnits: row.total_units === null ? null : numeric(row.total_units),
    stagePercent: row.stage_percent === null ? null : numeric(row.stage_percent),
    overallPercent: numeric(row.overall_percent),
    publicMessage: row.public_message,
    attempt: row.attempt,
    startedAt: nullableIso(row.started_at),
    heartbeatAt: nullableIso(row.heartbeat_at),
    finishedAt: nullableIso(row.finished_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapJob(row: JobRow, steps: readonly StepRow[]): IngestionJob {
  return IngestionJobSchema.parse({
    id: row.id,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    contentRevision: row.content_revision,
    pipelineVersion: row.pipeline_version,
    status: row.status,
    currentStep: row.current_step,
    overallPercent: numeric(row.overall_percent),
    publicMessage: row.public_message,
    attempt: row.attempt,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    heartbeatAt: nullableIso(row.heartbeat_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    steps: [...steps].sort((left, right) => left.position - right.position).map(mapStep),
  });
}

function mapUploadFile(row: UploadRow): UploadFileRecord {
  return {
    id: row.file_id,
    uploadSessionId: row.session_id,
    spaceId: row.space_id,
    clientFileId: row.client_file_id,
    originalFileName: row.original_file_name,
    strategy: row.strategy,
    bucket: row.bucket,
    objectKey: row.object_key,
    sizeBytes: numeric(row.size_bytes),
    contentType: row.content_type,
    ...(row.expected_sha256 ? { sha256: row.expected_sha256 } : {}),
    ...(row.multipart_upload_id ? { multipartUploadId: row.multipart_upload_id } : {}),
    partSizeBytes: row.part_size_bytes,
    partCount: row.part_count,
    sessionStatus: row.session_status,
    fileStatus: row.file_status,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

const uploadSelect = `
  SELECT us.id AS session_id, us.space_id, us.status AS session_status,
         us.expires_at, us.created_at AS session_created_at,
         uf.id AS file_id, uf.client_file_id, uf.original_file_name, uf.strategy,
         uf.bucket, uf.object_key, uf.size_bytes, uf.content_type, uf.expected_sha256,
         uf.multipart_upload_id, uf.part_size_bytes, uf.part_count, uf.status AS file_status
    FROM upload_sessions us
    JOIN upload_files uf ON uf.upload_session_id = us.id
`;

/** Adapter 实现显式 AccessContext 和 SQL 纵深权限过滤。 */
@Injectable()
export class PostgresDocumentIngestionRepository implements DocumentIngestionRepository {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  public async createUploadSession(
    context: AccessContext,
    command: CreateUploadSessionCommand,
  ): Promise<UploadSession> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertSpacePermission(client, context, command.spaceId, 'WRITE');
      await client.query(
        `INSERT INTO upload_sessions (id, space_id, created_by, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [command.id, command.spaceId, context.user.userId, command.expiresAt],
      );
      for (const file of command.files) {
        await client.query(
          `INSERT INTO upload_files (
             id, upload_session_id, client_file_id, original_file_name, strategy,
             bucket, object_key, size_bytes, content_type, expected_sha256,
             multipart_upload_id, part_size_bytes, part_count
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            file.id,
            command.id,
            file.clientFileId,
            file.originalFileName,
            file.strategy,
            file.bucket,
            file.objectKey,
            file.sizeBytes,
            file.contentType,
            file.sha256 ?? null,
            file.multipartUploadId ?? null,
            file.partSizeBytes,
            file.partCount,
          ],
        );
      }
      await client.query('COMMIT');
      return this.getUploadSession(context, command.id);
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) {
        throw new ApplicationError('DUPLICATE_RESOURCE', 409, '上传会话或文件标识冲突');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async getUploadSession(
    context: AccessContext,
    uploadSessionId: string,
  ): Promise<UploadSession> {
    await this.pool.query(
      `UPDATE upload_sessions SET status = 'EXPIRED', updated_at = now()
        WHERE id = $1 AND status = 'ACTIVE' AND expires_at <= now()`,
      [uploadSessionId],
    );
    const result = await this.pool.query<UploadRow>(
      `${uploadSelect}
        WHERE us.id = $1
          AND ($2::boolean OR us.created_by = $3)
        ORDER BY uf.created_at, uf.id`,
      [uploadSessionId, this.isSystemAdmin(context), context.user.userId],
    );
    if (result.rows.length === 0) throw new ApplicationError('NOT_FOUND', 404, '上传会话不存在');
    return this.mapUploadSession(result.rows);
  }

  public async getUploadFile(
    context: AccessContext,
    uploadFileId: string,
  ): Promise<UploadFileRecord> {
    await this.pool.query(
      `UPDATE upload_sessions us SET status = 'EXPIRED', updated_at = now()
        WHERE status = 'ACTIVE' AND expires_at <= now()
          AND EXISTS (
            SELECT 1 FROM upload_files uf WHERE uf.upload_session_id = us.id AND uf.id = $1
          )`,
      [uploadFileId],
    );
    const result = await this.pool.query<UploadRow>(
      `${uploadSelect}
        WHERE uf.id = $1
          AND ($2::boolean OR us.created_by = $3)`,
      [uploadFileId, this.isSystemAdmin(context), context.user.userId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError('NOT_FOUND', 404, '上传文件不存在');
    return mapUploadFile(row);
  }

  public async listUploadFiles(
    context: AccessContext,
    uploadSessionId: string,
  ): Promise<readonly UploadFileRecord[]> {
    const result = await this.pool.query<UploadRow>(
      `${uploadSelect}
        WHERE us.id = $1
          AND ($2::boolean OR us.created_by = $3)
        ORDER BY uf.created_at, uf.id`,
      [uploadSessionId, this.isSystemAdmin(context), context.user.userId],
    );
    if (result.rows.length === 0) throw new ApplicationError('NOT_FOUND', 404, '上传会话不存在');
    return result.rows.map(mapUploadFile);
  }

  public async getCompletedUploadResult(
    context: AccessContext,
    uploadFileId: string,
  ): Promise<CompleteUploadResult | undefined> {
    const owner = await this.pool.query<{ allowed: boolean; status: string }>(
      `SELECT ($2::boolean OR us.created_by = $3) AS allowed, uf.status
         FROM upload_files uf JOIN upload_sessions us ON us.id = uf.upload_session_id
        WHERE uf.id = $1`,
      [uploadFileId, this.isSystemAdmin(context), context.user.userId],
    );
    const row = owner.rows[0];
    if (!row?.allowed) return undefined;
    if (row.status !== 'COMPLETED') return undefined;
    return this.loadCompleteResult(this.pool, uploadFileId);
  }

  public async completeUpload(
    context: AccessContext,
    command: CompleteUploadCommand,
  ): Promise<CompleteUploadResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<
        UploadRow & {
          document_id: string | null;
          session_created_by: string;
        }
      >(
        `${uploadSelect.replace('SELECT ', 'SELECT us.created_by AS session_created_by, uf.document_id, ')}
          WHERE uf.id = $1
          FOR UPDATE OF us, uf`,
        [command.uploadFile.id],
      );
      const upload = locked.rows[0];
      if (
        !upload ||
        (!this.isSystemAdmin(context) && upload.session_created_by !== context.user.userId)
      ) {
        throw new ApplicationError('NOT_FOUND', 404, '上传文件不存在');
      }
      if (upload.file_status === 'COMPLETED') {
        const existing = await this.loadCompleteResult(client, command.uploadFile.id);
        await client.query('COMMIT');
        return existing;
      }
      if (
        upload.session_status !== 'ACTIVE' ||
        new Date(upload.expires_at).getTime() <= Date.now()
      ) {
        throw new ApplicationError('UPLOAD_EXPIRED', 410, '上传会话已过期或不可写');
      }
      await this.assertSpacePermission(client, context, upload.space_id, 'WRITE');

      const documentId = randomUUID();
      const versionId = randomUUID();
      const documentFileId = randomUUID();
      const pipelineVersion = 1;
      const contentRevision = 1;
      const jobId = createIngestionJobId(versionId, contentRevision, pipelineVersion);
      const documentResult = await client.query<DocumentRow>(
        `INSERT INTO documents (id, space_id, title, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          documentId,
          upload.space_id,
          titleFromFileName(upload.original_file_name),
          context.user.userId,
        ],
      );
      const versionResult = await client.query<VersionRow>(
        `INSERT INTO document_versions (
           id, document_id, version_number, content_revision, status, created_by
         ) VALUES ($1, $2, 1, $3, 'QUEUED', $4)
         RETURNING *`,
        [versionId, documentId, contentRevision, context.user.userId],
      );
      const fileResult = await client.query<FileRow>(
        `INSERT INTO document_files (
           id, document_version_id, original_file_name, bucket, object_key,
           size_bytes, content_type, etag, sha256
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          documentFileId,
          versionId,
          upload.original_file_name,
          upload.bucket,
          upload.object_key,
          command.object.sizeBytes,
          upload.content_type,
          command.object.etag ?? null,
          command.object.sha256 ?? command.sha256 ?? upload.expected_sha256,
        ],
      );
      await this.insertJobFacts(
        client,
        documentId,
        versionId,
        contentRevision,
        pipelineVersion,
        jobId,
        '文件已验证，等待安全扫描',
      );
      await client.query(
        `INSERT INTO protected_resource_spaces (resource_type, resource_id, space_id)
         VALUES ('DOCUMENT', $1, $2)`,
        [documentId, upload.space_id],
      );
      await client.query(
        `UPDATE knowledge_spaces
            SET document_count = document_count + 1, updated_at = now()
          WHERE id = $1`,
        [upload.space_id],
      );
      await client.query(
        `UPDATE upload_files
            SET status = 'COMPLETED', document_id = $2, document_version_id = $3,
                document_file_id = $4, ingestion_job_id = $5,
                completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [command.uploadFile.id, documentId, versionId, documentFileId, jobId],
      );
      await client.query(
        `UPDATE upload_sessions us
            SET status = CASE WHEN NOT EXISTS (
                  SELECT 1 FROM upload_files uf
                   WHERE uf.upload_session_id = us.id AND uf.status = 'PENDING'
                ) THEN 'COMPLETED' ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [upload.session_id],
      );
      await client.query('COMMIT');

      const documentRow = documentResult.rows[0];
      const versionRow = versionResult.rows[0];
      const fileRow = fileResult.rows[0];
      if (!documentRow || !versionRow || !fileRow) throw new Error('上传事务未返回完整事实');
      return CompleteUploadResultSchema.parse({
        uploadSession: await this.getUploadSession(context, upload.session_id),
        document: mapDocument(documentRow),
        documentVersion: mapVersion(versionRow),
        file: mapFile(fileRow),
        job: await this.requireJob(this.pool, jobId),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async cancelUploadSession(context: AccessContext, uploadSessionId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE upload_sessions us
          SET status = 'CANCELLED', updated_at = now()
        WHERE id = $1 AND status = 'ACTIVE'
          AND ($2::boolean OR created_by = $3)
      RETURNING id`,
      [uploadSessionId, this.isSystemAdmin(context), context.user.userId],
    );
    if (result.rowCount !== 1) {
      const current = await this.getUploadSession(context, uploadSessionId);
      if (current.status === 'CANCELLED') return;
      throw new ApplicationError('INVALID_STATE', 409, '上传会话不能取消');
    }
    await this.pool.query(
      `UPDATE upload_files SET status = 'CANCELLED', updated_at = now()
        WHERE upload_session_id = $1 AND status = 'PENDING'`,
      [uploadSessionId],
    );
  }

  public async listDocuments(
    context: AccessContext,
    query: ListDocumentsQuery,
  ): Promise<CursorResult<Document>> {
    const cursor = parseCursor(query.cursor);
    const result = await this.pool.query<DocumentRow>(
      `SELECT d.* FROM documents d
        WHERE ($1::boolean OR EXISTS (
          SELECT 1 FROM resource_acl acl
           WHERE acl.resource_id = d.space_id
             AND ((acl.subject_type = 'USER' AND acl.subject_id = $2)
               OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($3::text[])))
             AND acl.permissions && ARRAY['READ','WRITE','REVIEW','ADMIN']::text[]
        ))
          AND ($4::uuid IS NULL OR d.space_id = $4)
          AND ($5::text IS NULL OR d.status = $5)
          AND ($6::text IS NULL OR d.title ILIKE '%' || $6 || '%')
          AND ($7::timestamptz IS NULL OR (d.updated_at, d.id) < ($7, $8::uuid))
        ORDER BY d.updated_at DESC, d.id DESC
        LIMIT $9`,
      [
        this.isSystemAdmin(context),
        context.user.userId,
        [...context.user.roles],
        query.spaceId ?? null,
        query.status ?? null,
        query.search ?? null,
        cursor?.updatedAt ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      ],
    );
    return cursorResult(result.rows, query.limit, mapDocument);
  }

  public async getDocument(
    context: AccessContext,
    documentId: string,
  ): Promise<DocumentDetail | undefined> {
    const documentResult = await this.pool.query<DocumentRow>(
      `SELECT d.* FROM documents d
        WHERE d.id = $1 AND ($2::boolean OR EXISTS (
          SELECT 1 FROM resource_acl acl
           WHERE acl.resource_id = d.space_id
             AND ((acl.subject_type = 'USER' AND acl.subject_id = $3)
               OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($4::text[])))
        ))`,
      [documentId, this.isSystemAdmin(context), context.user.userId, [...context.user.roles]],
    );
    const documentRow = documentResult.rows[0];
    if (!documentRow) return undefined;
    const versions = await this.pool.query<VersionRow>(
      `SELECT * FROM document_versions WHERE document_id = $1 ORDER BY version_number DESC`,
      [documentId],
    );
    return { document: mapDocument(documentRow), versions: versions.rows.map(mapVersion) };
  }

  public async getDocumentVersion(
    context: AccessContext,
    documentVersionId: string,
  ): Promise<DocumentVersionDetail | undefined> {
    const versionResult = await this.pool.query<VersionRow>(
      `SELECT dv.* FROM document_versions dv
         JOIN documents d ON d.id = dv.document_id
        WHERE dv.id = $1 AND ($2::boolean OR EXISTS (
          SELECT 1 FROM resource_acl acl
           WHERE acl.resource_id = d.space_id
             AND ((acl.subject_type = 'USER' AND acl.subject_id = $3)
               OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($4::text[])))
        ))`,
      [
        documentVersionId,
        this.isSystemAdmin(context),
        context.user.userId,
        [...context.user.roles],
      ],
    );
    const version = versionResult.rows[0];
    if (!version) return undefined;
    const files = await this.pool.query<FileRow>(
      `SELECT * FROM document_files WHERE document_version_id = $1 ORDER BY created_at`,
      [documentVersionId],
    );
    return { version: mapVersion(version), files: files.rows.map(mapFile) };
  }

  public async reprocessDocumentVersion(
    context: AccessContext,
    documentVersionId: string,
    expectedVersion: number,
    reason: string,
  ): Promise<IngestionJob> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<VersionRow & { space_id: string }>(
        `SELECT dv.*, d.space_id FROM document_versions dv
           JOIN documents d ON d.id = dv.document_id
          WHERE dv.id = $1
          FOR UPDATE OF dv`,
        [documentVersionId],
      );
      const current = locked.rows[0];
      if (!current) throw new ApplicationError('NOT_FOUND', 404, '文档版本不存在');
      await this.assertSpacePermission(client, context, current.space_id, 'WRITE');
      if (
        current.optimistic_version !== expectedVersion ||
        !['SUCCEEDED', 'FAILED', 'CANCELLED', 'REJECTED'].includes(current.status)
      ) {
        throw new ApplicationError('VERSION_CONFLICT', 409, '版本已变化或当前状态不能重处理');
      }
      const contentRevision = current.content_revision + 1;
      const updated = await client.query<VersionRow>(
        `UPDATE document_versions
            SET content_revision = $2, status = 'QUEUED',
                optimistic_version = optimistic_version + 1, updated_at = now()
          WHERE id = $1
        RETURNING *`,
        [documentVersionId, contentRevision],
      );
      const pipelineVersion = 1;
      const jobId = createIngestionJobId(documentVersionId, contentRevision, pipelineVersion);
      await this.insertJobFacts(
        client,
        current.document_id,
        documentVersionId,
        contentRevision,
        pipelineVersion,
        jobId,
        '重处理已排队',
        { reason },
      );
      await client.query('COMMIT');
      if (!updated.rows[0]) throw new Error('重处理未返回文档版本');
      return this.requireJob(this.pool, jobId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async listJobs(
    context: AccessContext,
    query: ListIngestionJobsQuery,
  ): Promise<CursorResult<IngestionJob>> {
    const cursor = parseCursor(query.cursor);
    const result = await this.pool.query<JobRow>(
      `SELECT j.* FROM ingestion_jobs j
         JOIN documents d ON d.id = j.document_id
        WHERE ($1::boolean OR EXISTS (
          SELECT 1 FROM resource_acl acl
           WHERE acl.resource_id = d.space_id
             AND ((acl.subject_type = 'USER' AND acl.subject_id = $2)
               OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($3::text[])))
        ))
          AND ($4::uuid IS NULL OR d.space_id = $4)
          AND ($5::text IS NULL OR j.status = $5)
          AND ($6::timestamptz IS NULL OR (j.updated_at, j.id) < ($6, $7))
        ORDER BY j.updated_at DESC, j.id DESC
        LIMIT $8`,
      [
        this.isSystemAdmin(context),
        context.user.userId,
        [...context.user.roles],
        query.spaceId ?? null,
        query.status ?? null,
        cursor?.updatedAt ?? null,
        cursor?.id ?? null,
        query.limit + 1,
      ],
    );
    const selected = result.rows.slice(0, query.limit);
    const steps = await this.loadSteps(
      this.pool,
      selected.map((row) => row.id),
    );
    const mapped = selected.map((row) => mapJob(row, steps.get(row.id) ?? []));
    const last = selected.at(-1);
    return {
      items: mapped,
      nextCursor:
        result.rows.length > query.limit && last
          ? encodeCursor(iso(last.updated_at), last.id)
          : null,
      hasMore: result.rows.length > query.limit,
    };
  }

  public async getJob(context: AccessContext, jobId: string): Promise<IngestionJob | undefined> {
    const result = await this.pool.query<JobRow>(
      `SELECT j.* FROM ingestion_jobs j
         JOIN documents d ON d.id = j.document_id
        WHERE j.id = $1 AND ($2::boolean OR EXISTS (
          SELECT 1 FROM resource_acl acl
           WHERE acl.resource_id = d.space_id
             AND ((acl.subject_type = 'USER' AND acl.subject_id = $3)
               OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($4::text[])))
        ))`,
      [jobId, this.isSystemAdmin(context), context.user.userId, [...context.user.roles]],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return this.requireJob(this.pool, jobId, row);
  }

  public async cancelJob(
    context: AccessContext,
    jobId: string,
    reason: string,
  ): Promise<IngestionJob> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<JobRow & { space_id: string }>(
        `SELECT j.*, d.space_id FROM ingestion_jobs j
           JOIN documents d ON d.id = j.document_id
          WHERE j.id = $1 FOR UPDATE OF j`,
        [jobId],
      );
      const job = locked.rows[0];
      if (!job) throw new ApplicationError('NOT_FOUND', 404, '任务不存在');
      await this.assertSpacePermission(client, context, job.space_id, 'WRITE');
      if (job.status === 'CANCELLED') {
        await client.query('COMMIT');
        return this.requireJob(this.pool, jobId);
      }
      if (!['QUEUED', 'RUNNING', 'WAITING'].includes(job.status)) {
        throw new ApplicationError('INVALID_STATE', 409, '终态任务不能取消');
      }
      await client.query(
        `UPDATE ingestion_jobs
            SET status = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL,
                public_message = '用户已取消', updated_at = now()
          WHERE id = $1`,
        [jobId],
      );
      await client.query(
        `UPDATE ingestion_job_steps
            SET status = 'CANCELLED', public_message = '用户已取消',
                finished_at = now(), updated_at = now()
          WHERE job_id = $1 AND status IN ('QUEUED', 'RUNNING', 'WAITING')`,
        [jobId],
      );
      await client.query(
        `UPDATE document_versions
            SET status = 'CANCELLED', optimistic_version = optimistic_version + 1, updated_at = now()
          WHERE id = $1`,
        [job.document_version_id],
      );
      await this.insertJobEvent(client, jobId, 'ingestion.cancelled', { reason });
      await this.insertOutbox(client, jobId, 'ingestion.cancelled', {
        jobId,
        documentVersionId: job.document_version_id,
        contentRevision: job.content_revision,
      });
      await client.query('COMMIT');
      return this.requireJob(this.pool, jobId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async listJobEvents(
    context: AccessContext,
    jobId: string,
    afterEventId: number,
    limit: number,
  ): Promise<JobEventPage> {
    const visible = await this.getJob(context, jobId);
    if (!visible) throw new ApplicationError('NOT_FOUND', 404, '任务不存在');
    const result = await this.pool.query<EventRow>(
      `SELECT * FROM ingestion_job_events
        WHERE job_id = $1 AND id > $2
        ORDER BY id LIMIT $3`,
      [jobId, afterEventId, limit],
    );
    const items = result.rows.map(mapEvent);
    const nextCursor = items.at(-1)?.id ?? afterEventId;
    const etag = `"${createHash('sha256')
      .update(`${jobId}:${nextCursor}:${items.length}`)
      .digest('base64url')}"`;
    return { items, nextCursor, etag };
  }

  /** CTE 内的 FOR UPDATE SKIP LOCKED 允许多个 Publisher 横向扩容而不重复领取。 */
  public async claimOutboxBatch(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly OutboxEvent[]> {
    const result = await this.pool.query<OutboxRow>(
      `WITH candidates AS (
         SELECT id FROM outbox_events
          WHERE published_at IS NULL AND available_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY occurred_at
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE outbox_events event
          SET locked_by = $1,
              locked_until = now() + make_interval(secs => $3),
              attempts = attempts + 1
         FROM candidates
        WHERE event.id = candidates.id
      RETURNING event.*`,
      [workerId, limit, leaseSeconds],
    );
    return result.rows.map(mapOutbox);
  }

  public async markOutboxPublished(eventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox_events
          SET published_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL
        WHERE id = $1`,
      [eventId],
    );
  }

  public async releaseOutboxEvent(
    eventId: string,
    reason: string,
    retryDelaySeconds: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE outbox_events
          SET locked_by = NULL, locked_until = NULL, last_error = $2,
              available_at = now() + make_interval(secs => $3)
        WHERE id = $1 AND published_at IS NULL`,
      [eventId, reason, retryDelaySeconds],
    );
  }

  public async recordConsumerReceipt(consumerName: string, eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO outbox_consumer_receipts (consumer_name, event_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id`,
      [consumerName, eventId],
    );
    return result.rowCount === 1;
  }

  /**
   * Inbox 只证明消息已送达，不提前把任务改成 WAITING。
   * 即使收据重复，Consumer 仍会尝试领取 QUEUED lease，从而覆盖“写完收据后进程崩溃”的窗口。
   */
  public async consumeQueuedIngestion(
    consumerName: string,
    eventId: string,
    jobId: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const receipt = await client.query(
        `INSERT INTO outbox_consumer_receipts (consumer_name, event_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id`,
        [consumerName, eventId],
      );
      if (receipt.rowCount !== 1) {
        await client.query('COMMIT');
        return false;
      }
      await this.insertJobEvent(client, jobId, 'ingestion.message_received', {
        consumerName,
        receiptInserted: true,
      });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Worker 原子领取 QUEUED 任务并建立可续租 lease。 */
  public async acquireJobLease(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<IngestionJob | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<JobRow>(
        `UPDATE ingestion_jobs
            SET status = 'RUNNING', lease_owner = $2,
                lease_expires_at = now() + make_interval(secs => $3),
                heartbeat_at = now(), public_message = 'Worker 已领取任务', updated_at = now()
          WHERE id = $1 AND status = 'QUEUED'
        RETURNING *`,
        [jobId, workerId, leaseSeconds],
      );
      const job = claimed.rows[0];
      if (!job) {
        await client.query('COMMIT');
        return undefined;
      }
      await client.query(
        `UPDATE ingestion_job_steps
            SET status = 'RUNNING', started_at = COALESCE(started_at, now()),
                heartbeat_at = now(), public_message = '步骤执行中', updated_at = now()
          WHERE job_id = $1 AND step_name = $2 AND status = 'QUEUED'`,
        [jobId, job.current_step],
      );
      await client.query(
        `UPDATE document_versions
            SET status = 'PROCESSING', optimistic_version = optimistic_version + 1, updated_at = now()
          WHERE id = $1 AND status IN ('QUEUED', 'WAITING')`,
        [job.document_version_id],
      );
      await this.insertJobEvent(client, jobId, 'ingestion.running', {
        step: job.current_step,
        attempt: job.attempt,
      });
      await client.query(
        `INSERT INTO audit_logs (
           actor_user_id, actor_roles, action, resource_type, resource_id,
           result, reason, metadata, request_id
         ) VALUES (NULL, ARRAY[]::text[], 'INGESTION_STATUS_TRANSITION', 'DOCUMENT', $1,
           'SUCCESS', 'worker acquired lease', $2::jsonb, $3)`,
        [
          job.document_id,
          JSON.stringify({ jobId, from: 'QUEUED', to: 'RUNNING', workerId }),
          `worker:${workerId}:${jobId}:attempt:${job.attempt}`,
        ],
      );
      await client.query('COMMIT');
      return this.requireJob(this.pool, jobId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 当前 lease owner 才能续租；真实单位进度通过领域算法计算阶段和总体百分比。 */
  public async heartbeatJob(
    jobId: string,
    workerId: string,
    progress: {
      readonly stepName: IngestionStepName | null;
      readonly processedUnits: number;
      readonly totalUnits: number | null;
      readonly publicMessage: string;
    },
    leaseSeconds: number,
  ): Promise<IngestionJob | undefined> {
    if (!progress.stepName) return undefined;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<JobRow>(
        `SELECT * FROM ingestion_jobs
          WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2
            AND lease_expires_at > now()
          FOR UPDATE`,
        [jobId, workerId],
      );
      const job = locked.rows[0];
      if (!job || job.current_step !== progress.stepName) {
        await client.query('COMMIT');
        return undefined;
      }
      const stepRows = await client.query<StepRow>(
        `SELECT * FROM ingestion_job_steps WHERE job_id = $1 ORDER BY position FOR UPDATE`,
        [jobId],
      );
      const current = stepRows.rows.find((step) => step.step_name === progress.stepName);
      if (!current || current.status !== 'RUNNING') {
        await client.query('COMMIT');
        return undefined;
      }
      const stagePercent = calculateStagePercent(
        progress.processedUnits,
        progress.totalUnits,
        current.status,
      );
      const projected = stepRows.rows.map((step) =>
        step.id === current.id
          ? {
              ...mapStep(step),
              processedUnits: progress.processedUnits,
              totalUnits: progress.totalUnits,
              stagePercent,
            }
          : mapStep(step),
      );
      const overallPercent = calculateOverallPercent(projected);
      await client.query(
        `UPDATE ingestion_job_steps
            SET processed_units = $3, total_units = $4, stage_percent = $5,
                overall_percent = $6, public_message = $7,
                heartbeat_at = now(), updated_at = now()
          WHERE job_id = $1 AND step_name = $2`,
        [
          jobId,
          progress.stepName,
          progress.processedUnits,
          progress.totalUnits,
          stagePercent,
          overallPercent,
          progress.publicMessage,
        ],
      );
      await client.query(
        `UPDATE ingestion_jobs
            SET overall_percent = $3, public_message = $4, heartbeat_at = now(),
                lease_expires_at = now() + make_interval(secs => $5), updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [jobId, workerId, overallPercent, progress.publicMessage, leaseSeconds],
      );
      await client.query('COMMIT');
      return this.requireJob(this.pool, jobId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 长耗时 Parser/OCR 调用期间独立续租，不伪造处理单位或阶段百分比。 */
  public async renewJobLease(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ingestion_jobs
          SET lease_expires_at = now() + make_interval(secs => $3),
              heartbeat_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2
          AND lease_expires_at > now()
      RETURNING current_step`,
      [jobId, workerId, leaseSeconds],
    );
    if (result.rowCount !== 1) return false;
    await this.pool.query(
      `UPDATE ingestion_job_steps SET heartbeat_at = now(), updated_at = now()
        WHERE job_id = $1 AND status = 'RUNNING'`,
      [jobId],
    );
    return true;
  }

  /** 过期 lease 在事务行锁下只恢复一次；超过次数转 WAITING 供人工处理。 */
  public async recoverExpiredLeases(now: Date, maxAttempts: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const expired = await client.query<JobRow>(
        `SELECT * FROM ingestion_jobs
          WHERE status = 'RUNNING' AND lease_expires_at <= $1
          ORDER BY lease_expires_at
          FOR UPDATE SKIP LOCKED
          LIMIT 100`,
        [now],
      );
      for (const job of expired.rows) {
        const shouldWait = job.attempt >= maxAttempts;
        const nextStatus = shouldWait ? 'WAITING' : 'QUEUED';
        const nextAttempt = shouldWait ? job.attempt : job.attempt + 1;
        await client.query(
          `UPDATE ingestion_jobs
              SET status = $2, attempt = $3, lease_owner = NULL, lease_expires_at = NULL,
                  public_message = $4, updated_at = now()
            WHERE id = $1`,
          [
            job.id,
            nextStatus,
            nextAttempt,
            shouldWait ? '任务多次失联，等待人工处理' : 'Worker 失联，任务已安全重排队',
          ],
        );
        await client.query(
          `UPDATE ingestion_job_steps
              SET status = $2::varchar,
                  attempt = CASE WHEN $2::varchar = 'QUEUED' THEN attempt + 1 ELSE attempt END,
                  public_message = $3, heartbeat_at = NULL, updated_at = now()
            WHERE job_id = $1 AND status = 'RUNNING'`,
          [job.id, nextStatus, shouldWait ? '等待人工处理' : 'Worker 失联，步骤已重排队'],
        );
        await this.insertJobEvent(client, job.id, 'ingestion.lease_expired', {
          previousAttempt: job.attempt,
          nextStatus,
        });
        await client.query(
          `INSERT INTO audit_logs (
             actor_user_id, actor_roles, action, resource_type, resource_id,
             result, reason, metadata, request_id
           ) VALUES (NULL, ARRAY[]::text[], 'INGESTION_LEASE_RECOVERY', 'DOCUMENT', $1,
             'SUCCESS', 'worker lease expired', $2::jsonb, $3)`,
          [
            job.document_id,
            JSON.stringify({ jobId: job.id, previousAttempt: job.attempt, nextStatus }),
            `scheduler:${job.id}:attempt:${job.attempt}`,
          ],
        );
        if (!shouldWait) {
          await this.insertOutbox(client, job.id, `ingestion.recovery.requested.v${nextAttempt}`, {
            jobId: job.id,
            attempt: nextAttempt,
          });
        }
      }
      await client.query(
        `UPDATE upload_sessions
            SET status = 'EXPIRED', updated_at = now()
          WHERE status = 'ACTIVE' AND expires_at <= $1`,
        [now],
      );
      await client.query('COMMIT');
      return expired.rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private mapUploadSession(rows: readonly UploadRow[]): UploadSession {
    const first = rows[0];
    if (!first) throw new ApplicationError('NOT_FOUND', 404, '上传会话不存在');
    return UploadSessionSchema.parse({
      id: first.session_id,
      spaceId: first.space_id,
      status: first.session_status,
      expiresAt: iso(first.expires_at),
      createdAt: iso(first.session_created_at),
      files: rows.map((row) => ({
        fileId: row.file_id,
        clientFileId: row.client_file_id,
        originalFileName: row.original_file_name,
        sizeBytes: numeric(row.size_bytes),
        contentType: row.content_type,
        strategy: row.strategy,
        partSizeBytes: row.part_size_bytes,
        partCount: row.part_count,
        uploadUrl: null,
        expiresAt: iso(row.expires_at),
        completed: row.file_status === 'COMPLETED',
      })),
    });
  }

  private async loadCompleteResult(
    queryable: Queryable,
    uploadFileId: string,
  ): Promise<CompleteUploadResult> {
    const links = await queryable.query<{
      upload_session_id: string;
      document_id: string;
      document_version_id: string;
      document_file_id: string;
      ingestion_job_id: string;
    }>(
      `SELECT upload_session_id, document_id, document_version_id, document_file_id, ingestion_job_id
         FROM upload_files WHERE id = $1 AND status = 'COMPLETED'`,
      [uploadFileId],
    );
    const link = links.rows[0];
    if (!link) throw new ApplicationError('NOT_FOUND', 404, '已完成上传事实不存在');
    // Queryable 可能是单个事务连接；顺序执行兼容 pg 9 将移除的并发 client.query 行为。
    const uploadRows = await queryable.query<UploadRow>(
      `${uploadSelect} WHERE us.id = $1 ORDER BY uf.created_at, uf.id`,
      [link.upload_session_id],
    );
    const documentRows = await queryable.query<DocumentRow>(
      'SELECT * FROM documents WHERE id = $1',
      [link.document_id],
    );
    const versionRows = await queryable.query<VersionRow>(
      'SELECT * FROM document_versions WHERE id = $1',
      [link.document_version_id],
    );
    const fileRows = await queryable.query<FileRow>('SELECT * FROM document_files WHERE id = $1', [
      link.document_file_id,
    ]);
    const job = await this.requireJob(queryable, link.ingestion_job_id);
    const document = documentRows.rows[0];
    const version = versionRows.rows[0];
    const file = fileRows.rows[0];
    if (!document || !version || !file) throw new Error('上传完成引用的业务事实不完整');
    return CompleteUploadResultSchema.parse({
      uploadSession: this.mapUploadSession(uploadRows.rows),
      document: mapDocument(document),
      documentVersion: mapVersion(version),
      file: mapFile(file),
      job,
    });
  }

  private async insertJobFacts(
    client: PoolClient,
    documentId: string,
    documentVersionId: string,
    contentRevision: number,
    pipelineVersion: number,
    jobId: string,
    message: string,
    extraPayload: Record<string, unknown> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO ingestion_jobs (
         id, document_id, document_version_id, content_revision, pipeline_version,
         status, current_step, public_message
       ) VALUES ($1, $2, $3, $4, $5, 'QUEUED', 'SECURITY_SCAN', $6)`,
      [jobId, documentId, documentVersionId, contentRevision, pipelineVersion, message],
    );
    for (const [index, step] of INGESTION_STEP_ORDER.entries()) {
      await client.query(
        `INSERT INTO ingestion_job_steps (
           id, job_id, step_name, step_version, position, status, weight_percent,
           processed_units, total_units, stage_percent, overall_percent, public_message
         ) VALUES ($1, $2, $3, 1, $4, 'QUEUED', $5, 0, NULL, NULL, 0, $6)`,
        [
          createIngestionStepId(documentVersionId, contentRevision, step, 1),
          jobId,
          step,
          index + 1,
          INGESTION_STEP_WEIGHTS[step],
          index === 0 ? message : '等待前置步骤',
        ],
      );
    }
    const payload = {
      jobId,
      documentId,
      documentVersionId,
      contentRevision,
      pipelineVersion,
      ...extraPayload,
    };
    await this.insertJobEvent(client, jobId, 'ingestion.queued', payload);
    await this.insertOutbox(client, jobId, 'ingestion.requested', payload);
  }

  private async insertJobEvent(
    client: PoolClient,
    jobId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ingestion_job_events (job_id, event_type, data)
       VALUES ($1, $2, $3::jsonb)`,
      [jobId, eventType, JSON.stringify(data)],
    );
  }

  private async insertOutbox(
    client: PoolClient,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('INGESTION_JOB', $1, $2, $3::jsonb)
       ON CONFLICT (aggregate_id, event_type) DO NOTHING`,
      [aggregateId, eventType, JSON.stringify(payload)],
    );
  }

  private async requireJob(
    queryable: Queryable,
    jobId: string,
    knownRow?: JobRow,
  ): Promise<IngestionJob> {
    const row =
      knownRow ??
      (await queryable.query<JobRow>('SELECT * FROM ingestion_jobs WHERE id = $1', [jobId]))
        .rows[0];
    if (!row) throw new ApplicationError('NOT_FOUND', 404, '任务不存在');
    const steps = await this.loadSteps(queryable, [jobId]);
    return mapJob(row, steps.get(jobId) ?? []);
  }

  private async loadSteps(
    queryable: Queryable,
    jobIds: readonly string[],
  ): Promise<Map<string, StepRow[]>> {
    if (jobIds.length === 0) return new Map();
    const result = await queryable.query<StepRow>(
      `SELECT * FROM ingestion_job_steps
        WHERE job_id = ANY($1::varchar[]) ORDER BY job_id, position`,
      [[...jobIds]],
    );
    const grouped = new Map<string, StepRow[]>();
    for (const row of result.rows) {
      const rows = grouped.get(row.job_id) ?? [];
      rows.push(row);
      grouped.set(row.job_id, rows);
    }
    return grouped;
  }

  private async assertSpacePermission(
    queryable: Queryable,
    context: AccessContext,
    spaceId: string,
    permission: 'WRITE',
  ): Promise<void> {
    const result = await queryable.query(
      `SELECT ks.id FROM knowledge_spaces ks
        WHERE ks.id = $1 AND ks.status = 'ACTIVE'
          AND ($2::boolean OR EXISTS (
            SELECT 1 FROM resource_acl acl
             WHERE acl.resource_id = ks.id
               AND ((acl.subject_type = 'USER' AND acl.subject_id = $3)
                 OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($4::text[])))
               AND acl.permissions && ARRAY[$5,'ADMIN']::text[]
          ))`,
      [
        spaceId,
        this.isSystemAdmin(context),
        context.user.userId,
        [...context.user.roles],
        permission,
      ],
    );
    if (result.rowCount !== 1)
      throw new ApplicationError('ACCESS_DENIED', 403, '无权写入该知识空间');
  }

  private isSystemAdmin(context: AccessContext): boolean {
    return context.user.roles.includes('SYSTEM_ADMIN');
  }
}

function mapEvent(row: EventRow): IngestionJobEvent {
  return IngestionJobEventSchema.parse({
    id: numeric(row.id),
    jobId: row.job_id,
    eventType: row.event_type,
    data: row.data,
    occurredAt: iso(row.occurred_at),
  });
}

function mapOutbox(row: OutboxRow): OutboxEvent {
  return OutboxEventSchema.parse({
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: iso(row.occurred_at),
    publishedAt: row.published_at === null ? null : iso(row.published_at),
    attempts: row.attempts,
  });
}

/** 文件名已在领域层净化，这里只去掉最后一个扩展名作为默认标题。 */
function titleFromFileName(fileName: string): string {
  const title = fileName.replace(/\.[^.]+$/, '').trim();
  return title || fileName;
}

/** 游标内容只是排序键，不含权限事实；篡改只会导致校验失败。 */
function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), 'utf8').toString('base64url');
}

function parseCursor(value: string | undefined): { updatedAt: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      typeof parsed.id !== 'string' ||
      parsed.id.length === 0
    ) {
      throw new Error('invalid cursor');
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    throw new ApplicationError('INVALID_STATE', 409, '分页游标无效');
  }
}

function cursorResult<TRow extends DocumentRow, TItem>(
  rows: readonly TRow[],
  limit: number,
  mapper: (row: TRow) => TItem,
): CursorResult<TItem> {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected.map(mapper),
    nextCursor: rows.length > limit && last ? encodeCursor(iso(last.updated_at), last.id) : null,
    hasMore: rows.length > limit,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
