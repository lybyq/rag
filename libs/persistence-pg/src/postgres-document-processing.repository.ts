/**
 * M03 PostgreSQL Repository。
 * 解析运行、统一 Block、问题与入库步骤状态在事务中共同提交，避免“对象已写但任务显示成功”的裂脑。
 *
 * @requirement PAR-012
 * @requirement PAR-013
 * @requirement PAR-015
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ApplicationError,
  type AccessContext,
  type BeginParseRunCommand,
  type CompleteDocumentProcessingCommand,
  type DocumentBlockPage,
  type DocumentProcessingInput,
  type DocumentProcessingRepository,
  type FailDocumentProcessingCommand,
  type RecordPreflightCommand,
  type RecordSecurityCommand,
} from '@rag/application';
import {
  DocumentBlockSchema,
  DocumentParseRunSchema,
  ParseIssueSchema,
  type DocumentBlock,
  type DocumentParseRun,
  type ListDocumentBlocksQuery,
  type ParseIssue,
} from '@rag/contracts';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

interface ProcessingInputRow extends QueryResultRow {
  job_id: string;
  document_id: string;
  document_version_id: string;
  content_revision: number;
  attempt: number;
  file_id: string;
  original_file_name: string;
  bucket: string;
  object_key: string;
  size_bytes: string | number;
  content_type: string;
  sha256: string | null;
}

interface ParseRunRow extends QueryResultRow {
  id: string;
  job_id: string;
  document_version_id: string;
  content_revision: number;
  status: string;
  file_format: string | null;
  declared_mime: string | null;
  detected_mime: string | null;
  input_sha256: string | null;
  security_verdict: string | null;
  malware_engine: string | null;
  malware_revision: string | null;
  parser_profile_id: string;
  parser_revision: string;
  ocr_profile_id: string;
  ocr_revision: string;
  page_count: number;
  block_count: number;
  ocr_page_count: number;
  derived_bucket: string | null;
  derived_object_key: string | null;
  derived_sha256: string | null;
  failure_class: string | null;
  failure_code: string | null;
  failure_message: string | null;
  metrics: Record<string, unknown>;
  started_at: Date | string;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BlockRow extends QueryResultRow {
  id: string;
  parse_run_id: string;
  document_version_id: string;
  content_revision: number;
  ordinal: number;
  block_type: string;
  text_content: string;
  original_text: string;
  page_no: number | null;
  sheet_name: string | null;
  slide_no: number | null;
  bbox: unknown;
  heading_level: number | null;
  parent_block_id: string | null;
  confidence: string | number | null;
  table_data: unknown;
  parser_name: string;
  parser_revision: string;
  ocr_engine: string | null;
  ocr_revision: string | null;
  metadata: Record<string, unknown>;
  content_sha256: string;
  created_at: Date | string;
}

interface IssueRow extends QueryResultRow {
  id: string;
  parse_run_id: string;
  severity: string;
  code: string;
  message: string;
  page_no: number | null;
  block_id: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
}

@Injectable()
export class PostgresDocumentProcessingRepository implements DocumentProcessingRepository {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /** 只把仍由当前 Worker 持有有效 lease 的输入返回给编排器。 */
  public async loadInput(
    jobId: string,
    workerId: string,
  ): Promise<DocumentProcessingInput | undefined> {
    const result = await this.pool.query<ProcessingInputRow>(
      `SELECT j.id AS job_id, j.document_id, j.document_version_id, j.content_revision, j.attempt,
              f.id AS file_id, f.original_file_name, f.bucket, f.object_key, f.size_bytes,
              f.content_type, f.sha256
         FROM ingestion_jobs j
         JOIN document_files f ON f.document_version_id = j.document_version_id
        WHERE j.id = $1 AND j.status = 'RUNNING' AND j.lease_owner = $2
          AND j.lease_expires_at > now()`,
      [jobId, workerId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      jobId: row.job_id,
      documentId: row.document_id,
      documentVersionId: row.document_version_id,
      contentRevision: row.content_revision,
      attempt: row.attempt,
      fileId: row.file_id,
      originalFileName: row.original_file_name,
      bucket: row.bucket,
      objectKey: row.object_key,
      sizeBytes: Number(row.size_bytes),
      declaredMime: row.content_type,
      uploadedSha256: row.sha256,
    };
  }

  /** 同一 Job 重试复用一个 Parse Run 行，并清空上一次失败摘要。 */
  public async beginRun(command: BeginParseRunCommand): Promise<DocumentParseRun> {
    const result = await this.pool.query<ParseRunRow>(
      `INSERT INTO document_parse_runs (
         job_id, document_version_id, content_revision, attempt, status, declared_mime,
         parser_profile_id, parser_revision, ocr_profile_id, ocr_revision
       ) VALUES ($1, $2, $3, $4, 'RUNNING', $5, $6, $7, $8, $9)
       ON CONFLICT (job_id) DO UPDATE SET
         attempt = EXCLUDED.attempt, status = 'RUNNING', declared_mime = EXCLUDED.declared_mime,
         parser_profile_id = EXCLUDED.parser_profile_id, parser_revision = EXCLUDED.parser_revision,
         ocr_profile_id = EXCLUDED.ocr_profile_id, ocr_revision = EXCLUDED.ocr_revision,
         failure_class = NULL, failure_code = NULL, failure_message = NULL,
         completed_at = NULL, started_at = now(), updated_at = now()
       RETURNING *`,
      [
        command.input.jobId,
        command.input.documentVersionId,
        command.input.contentRevision,
        command.input.attempt,
        command.input.declaredMime,
        command.parserProfileId,
        command.parserRevision,
        command.ocrProfileId,
        command.ocrRevision,
      ],
    );
    return mapRun(requireRow(result.rows[0], '解析运行创建失败'));
  }

  /** Scanner 结果先落库；INFECTED 文件不会再进入 Parser。 */
  public async recordPreflight(command: RecordPreflightCommand): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, command.jobId, command.workerId);
      const infected = command.malware.verdict === 'INFECTED';
      const findings = infected
        ? [
            {
              severity: 'ERROR',
              code: 'MALWARE_DETECTED',
              message: '恶意软件扫描命中',
            },
          ]
        : [];
      await client.query(
        `UPDATE document_files
            SET trusted_sha256 = $2, detected_mime = $3, file_format = $4,
                scan_status = $5, scan_engine = $6, scan_revision = $7,
                scan_completed_at = now(), security_findings = $8::jsonb
          WHERE id = $1`,
        [
          command.fileId,
          command.trustedSha256,
          command.detectedMime,
          command.format,
          infected ? 'REJECTED' : 'CLEAN',
          command.malware.engine,
          command.malware.engineRevision,
          JSON.stringify(findings),
        ],
      );
      await client.query(
        `UPDATE document_parse_runs
            SET file_format = $2, detected_mime = $3, input_sha256 = $4,
                security_verdict = CASE WHEN $5::boolean THEN 'REJECTED' ELSE NULL END,
                malware_engine = $6, malware_revision = $7,
                metrics = metrics || $8::jsonb, updated_at = now()
          WHERE id = $1`,
        [
          command.parseRunId,
          command.format,
          command.detectedMime,
          command.trustedSha256,
          infected,
          command.malware.engine,
          command.malware.engineRevision,
          JSON.stringify({
            scannerDurationMs: command.malware.durationMs,
            scannedBytes: command.malware.scannedBytes,
          }),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordSecurity(command: RecordSecurityCommand): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, command.jobId, command.workerId);
      await client.query(
        `UPDATE document_files
            SET trusted_sha256 = $2, detected_mime = $3, file_format = $4,
                scan_status = $5, scan_engine = $6, scan_revision = $7,
                scan_completed_at = now(), security_findings = $8::jsonb
          WHERE id = $1`,
        [
          command.fileId,
          command.trustedSha256,
          command.detectedMime,
          command.format,
          command.verdict,
          command.malware.engine,
          command.malware.engineRevision,
          JSON.stringify(command.findings),
        ],
      );
      await client.query(
        `UPDATE document_parse_runs
            SET file_format = $2, detected_mime = $3, input_sha256 = $4,
                security_verdict = $5, malware_engine = $6, malware_revision = $7,
                metrics = metrics || $8::jsonb, updated_at = now()
          WHERE id = $1`,
        [
          command.parseRunId,
          command.format,
          command.detectedMime,
          command.trustedSha256,
          command.verdict,
          command.malware.engine,
          command.malware.engineRevision,
          JSON.stringify({
            scannerDurationMs: command.malware.durationMs,
            scannedBytes: command.malware.scannedBytes,
            securityFindingCount: command.findings.length,
          }),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 目标步骤开始时，把所有前置步骤确定性标为成功；跳过 OCR 也留下“无需 OCR”事实。 */
  public async startStep(
    jobId: string,
    workerId: string,
    step: 'PARSE' | 'OCR' | 'NORMALIZE',
    publicMessage: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, jobId, workerId);
      const target = await client.query<{ position: number }>(
        'SELECT position FROM ingestion_job_steps WHERE job_id = $1 AND step_name = $2',
        [jobId, step],
      );
      const position = requireRow(target.rows[0], '目标步骤不存在').position;
      await client.query(
        `UPDATE ingestion_job_steps
            SET status = 'SUCCEEDED', processed_units = GREATEST(processed_units, 1),
                total_units = COALESCE(total_units, 1), stage_percent = 100,
                public_message = CASE WHEN step_name = 'OCR' THEN '无需 OCR，步骤已跳过' ELSE '步骤已完成' END,
                finished_at = COALESCE(finished_at, now()), updated_at = now()
          WHERE job_id = $1 AND position < $2 AND status IN ('QUEUED', 'RUNNING')`,
        [jobId, position],
      );
      await client.query(
        `UPDATE ingestion_job_steps
            SET status = 'RUNNING', started_at = COALESCE(started_at, now()),
                heartbeat_at = now(), public_message = $3, updated_at = now()
          WHERE job_id = $1 AND step_name = $2`,
        [jobId, step, publicMessage],
      );
      const completed = await client.query<{ overall_percent: string }>(
        `SELECT COALESCE(SUM(weight_percent), 0)::text AS overall_percent
           FROM ingestion_job_steps WHERE job_id = $1 AND status = 'SUCCEEDED'`,
        [jobId],
      );
      const overallPercent = Number(completed.rows[0]?.overall_percent ?? 0);
      await client.query('UPDATE ingestion_job_steps SET overall_percent = $2 WHERE job_id = $1', [
        jobId,
        overallPercent,
      ]);
      await client.query(
        `UPDATE ingestion_jobs SET current_step = $3, public_message = $4,
                overall_percent = $5, heartbeat_at = now(), updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [jobId, workerId, step, publicMessage, overallPercent],
      );
      await this.insertEvent(client, jobId, 'ingestion.step_started', { step });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async complete(command: CompleteDocumentProcessingCommand): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, command.jobId, command.workerId);
      await client.query('DELETE FROM document_parse_issues WHERE parse_run_id = $1', [
        command.parseRunId,
      ]);
      await client.query('DELETE FROM document_blocks WHERE parse_run_id = $1', [
        command.parseRunId,
      ]);
      for (const block of command.blocks) {
        await client.query(
          `INSERT INTO document_blocks (
             id, parse_run_id, document_version_id, content_revision, ordinal, block_type,
             text_content, original_text, page_no, sheet_name, slide_no, bbox, heading_level,
             parent_block_id, confidence, table_data, parser_name, parser_revision,
             ocr_engine, ocr_revision, metadata, content_sha256
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16::jsonb,
             $17,$18,$19,$20,$21::jsonb,$22
           )`,
          [
            block.id,
            block.parseRunId,
            block.documentVersionId,
            block.contentRevision,
            block.ordinal,
            block.type,
            block.text,
            block.originalText,
            block.pageNo,
            block.sheetName,
            block.slideNo,
            block.bbox ? JSON.stringify(block.bbox) : null,
            block.headingLevel,
            block.parentBlockId,
            block.confidence,
            block.table ? JSON.stringify(block.table) : null,
            block.parserName,
            block.parserRevision,
            block.ocrEngine,
            block.ocrRevision,
            JSON.stringify(block.metadata),
            block.contentSha256,
          ],
        );
      }
      for (const issue of command.issues) {
        await client.query(
          `INSERT INTO document_parse_issues (
             parse_run_id, severity, code, message, page_no, block_id, metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            command.parseRunId,
            issue.severity,
            issue.code,
            issue.message,
            issue.pageNo,
            issue.blockId,
            JSON.stringify(issue.metadata),
          ],
        );
      }
      await client.query(
        `UPDATE document_parse_runs
            SET status = 'SUCCEEDED', page_count = $2, block_count = $3, ocr_page_count = $4,
                derived_bucket = $5, derived_object_key = $6, derived_sha256 = $7,
                metrics = metrics || $8::jsonb, completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [
          command.parseRunId,
          command.parser.pages.length,
          command.blocks.length,
          command.ocr?.pages.length ?? 0,
          command.derivedBucket,
          command.derivedObjectKey,
          command.derivedSha256,
          JSON.stringify({
            durationMs: command.durationMs,
            parserDurationMs: command.parser.durationMs,
            ocrDurationMs: command.ocr?.durationMs ?? 0,
            snapshotReused: command.snapshotReused,
          }),
        ],
      );
      await client.query(
        `UPDATE ingestion_job_steps
            SET status = 'SUCCEEDED', processed_units = GREATEST(processed_units, 1),
                total_units = COALESCE(total_units, 1), stage_percent = 100,
                overall_percent = 50, public_message = 'M03 步骤已完成',
                finished_at = COALESCE(finished_at, now()), updated_at = now()
          WHERE job_id = $1 AND position <= 4`,
        [command.jobId],
      );
      await client.query(
        `UPDATE ingestion_job_steps
            SET status = 'WAITING', overall_percent = 50,
                public_message = '等待 M04 分块与质量门禁', updated_at = now()
          WHERE job_id = $1 AND step_name = 'CHUNK'`,
        [command.jobId],
      );
      await client.query(
        `UPDATE ingestion_jobs
            SET status = 'WAITING', current_step = 'CHUNK', overall_percent = 50,
                public_message = 'M03 解析完成，等待 M04', lease_owner = NULL,
                lease_expires_at = NULL, heartbeat_at = now(), updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [command.jobId, command.workerId],
      );
      await client.query(
        `UPDATE document_versions SET status = 'WAITING', updated_at = now()
          WHERE id = (SELECT document_version_id FROM ingestion_jobs WHERE id = $1)`,
        [command.jobId],
      );
      await this.insertEvent(client, command.jobId, 'ingestion.m03_completed', {
        parseRunId: command.parseRunId,
        blockCount: command.blocks.length,
        ocrPageCount: command.ocr?.pages.length ?? 0,
        snapshotReused: command.snapshotReused,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async waitForManualReview(
    jobId: string,
    workerId: string,
    parseRunId: string,
    publicMessage: string,
  ): Promise<void> {
    await this.finishNonSuccess(jobId, workerId, parseRunId, 'WAITING', publicMessage, null, null);
  }

  public async fail(command: FailDocumentProcessingCommand): Promise<void> {
    const status = command.retryable
      ? 'QUEUED'
      : command.failureClass === 'DOCUMENT_PROBLEM'
        ? 'REJECTED'
        : 'WAITING';
    await this.finishNonSuccess(
      command.jobId,
      command.workerId,
      command.parseRunId,
      status,
      command.publicMessage,
      command.failureClass,
      command.failureCode,
    );
  }

  public async listRuns(
    context: AccessContext,
    documentVersionId: string,
  ): Promise<readonly DocumentParseRun[]> {
    await this.assertVersionAccess(context, documentVersionId);
    const result = await this.pool.query<ParseRunRow>(
      `SELECT * FROM document_parse_runs
        WHERE document_version_id = $1 ORDER BY content_revision DESC, created_at DESC`,
      [documentVersionId],
    );
    return result.rows.map(mapRun);
  }

  public async getRun(
    context: AccessContext,
    parseRunId: string,
  ): Promise<{ run: DocumentParseRun; issues: readonly ParseIssue[] } | undefined> {
    const result = await this.pool.query<ParseRunRow>(
      'SELECT * FROM document_parse_runs WHERE id = $1',
      [parseRunId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    await this.assertVersionAccess(context, row.document_version_id);
    const issues = await this.pool.query<IssueRow>(
      `SELECT * FROM document_parse_issues
        WHERE parse_run_id = $1 ORDER BY created_at, id`,
      [parseRunId],
    );
    return { run: mapRun(row), issues: issues.rows.map(mapIssue) };
  }

  public async listBlocks(
    context: AccessContext,
    parseRunId: string,
    query: ListDocumentBlocksQuery,
  ): Promise<DocumentBlockPage> {
    const run = await this.pool.query<{ document_version_id: string }>(
      'SELECT document_version_id FROM document_parse_runs WHERE id = $1',
      [parseRunId],
    );
    const runRow = run.rows[0];
    if (!runRow) throw new ApplicationError('NOT_FOUND', 404, '解析运行不存在');
    await this.assertVersionAccess(context, runRow.document_version_id);
    const result = await this.pool.query<BlockRow>(
      `SELECT * FROM document_blocks
        WHERE parse_run_id = $1 AND ordinal > $2
        ORDER BY ordinal LIMIT $3`,
      [parseRunId, query.afterOrdinal, query.limit + 1],
    );
    const selected = result.rows.slice(0, query.limit).map(mapBlock);
    return {
      items: selected,
      nextOrdinal: result.rows.length > query.limit ? (selected.at(-1)?.ordinal ?? null) : null,
    };
  }

  private async finishNonSuccess(
    jobId: string,
    workerId: string,
    parseRunId: string | null,
    status: 'QUEUED' | 'WAITING' | 'REJECTED',
    publicMessage: string,
    failureClass: string | null,
    failureCode: string | null,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertLease(client, jobId, workerId);
      if (parseRunId) {
        await client.query(
          `UPDATE document_parse_runs
              SET status = $2, failure_class = $3, failure_code = $4,
                  failure_message = $5, completed_at = CASE WHEN $2 = 'QUEUED' THEN NULL ELSE now() END,
                  updated_at = now()
            WHERE id = $1`,
          [
            parseRunId,
            status === 'QUEUED' ? 'FAILED' : status,
            failureClass,
            failureCode,
            publicMessage,
          ],
        );
      }
      if (failureClass === 'DOCUMENT_PROBLEM') {
        await client.query(
          `UPDATE document_files
              SET scan_status = 'REJECTED',
                  security_findings = jsonb_build_array(jsonb_build_object(
                    'severity', 'ERROR', 'code', $2::text, 'message', $3::text
                  )),
                  scan_completed_at = COALESCE(scan_completed_at, now())
            WHERE document_version_id = (
              SELECT document_version_id FROM ingestion_jobs WHERE id = $1
            ) AND scan_status = 'PENDING'`,
          [jobId, failureCode ?? 'DOCUMENT_REJECTED', publicMessage],
        );
      }
      await client.query(
        `UPDATE ingestion_job_steps
            SET status = $3, public_message = $4,
                attempt = CASE WHEN $3 = 'QUEUED' THEN attempt + 1 ELSE attempt END,
                finished_at = CASE WHEN $3 IN ('WAITING','REJECTED') THEN now() ELSE NULL END,
                updated_at = now()
          WHERE job_id = $1 AND step_name = (
            SELECT current_step FROM ingestion_jobs WHERE id = $1 AND lease_owner = $2
          )`,
        [jobId, workerId, status, publicMessage],
      );
      await client.query(
        `UPDATE ingestion_jobs
            SET status = $3, public_message = $4,
                attempt = CASE WHEN $3 = 'QUEUED' THEN attempt + 1 ELSE attempt END,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [jobId, workerId, status, publicMessage],
      );
      await client.query(
        `UPDATE document_versions SET status = $2, updated_at = now()
          WHERE id = (SELECT document_version_id FROM ingestion_jobs WHERE id = $1)`,
        [jobId, status],
      );
      await this.insertEvent(client, jobId, `ingestion.m03_${status.toLowerCase()}`, {
        parseRunId,
        failureClass,
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

  private async assertLease(client: PoolClient, jobId: string, workerId: string): Promise<void> {
    const locked = await client.query(
      `SELECT 1 FROM ingestion_jobs
        WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2
          AND lease_expires_at > now() FOR UPDATE`,
      [jobId, workerId],
    );
    if (locked.rowCount !== 1) {
      throw new ApplicationError('INVALID_STATE', 409, 'Worker 租约已失效，禁止提交处理结果');
    }
  }

  private async assertVersionAccess(
    context: AccessContext,
    documentVersionId: string,
  ): Promise<void> {
    const allowed = await this.pool.query(
      `SELECT 1
         FROM document_versions dv
         JOIN documents d ON d.id = dv.document_id
        WHERE dv.id = $1 AND (
          $2::boolean OR EXISTS (
            SELECT 1 FROM resource_acl acl
             WHERE acl.resource_id = d.space_id
               AND ((acl.subject_type = 'USER' AND acl.subject_id = $3)
                 OR (acl.subject_type = 'ROLE' AND acl.subject_id = ANY($4::text[])))
               AND acl.permissions && ARRAY['READ','WRITE','ADMIN']::text[]
          )
        )`,
      [
        documentVersionId,
        context.user.roles.includes('SYSTEM_ADMIN'),
        context.user.userId,
        [...context.user.roles],
      ],
    );
    if (allowed.rowCount !== 1) throw new ApplicationError('NOT_FOUND', 404, '文档版本不存在');
  }

  private async insertEvent(
    client: PoolClient,
    jobId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ingestion_job_events (job_id, event_type, data) VALUES ($1,$2,$3::jsonb)`,
      [jobId, eventType, JSON.stringify(data)],
    );
  }
}

function mapRun(row: ParseRunRow): DocumentParseRun {
  return DocumentParseRunSchema.parse({
    id: row.id,
    jobId: row.job_id,
    documentVersionId: row.document_version_id,
    contentRevision: row.content_revision,
    status: row.status,
    fileFormat: row.file_format,
    declaredMime: row.declared_mime,
    detectedMime: row.detected_mime,
    inputSha256: row.input_sha256,
    securityVerdict: row.security_verdict,
    malwareEngine: row.malware_engine,
    malwareRevision: row.malware_revision,
    parserProfileId: row.parser_profile_id,
    parserRevision: row.parser_revision,
    ocrProfileId: row.ocr_profile_id,
    ocrRevision: row.ocr_revision,
    pageCount: row.page_count,
    blockCount: row.block_count,
    ocrPageCount: row.ocr_page_count,
    derivedBucket: row.derived_bucket,
    derivedObjectKey: row.derived_object_key,
    derivedSha256: row.derived_sha256,
    failureClass: row.failure_class,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    metrics: row.metrics,
    startedAt: iso(row.started_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapBlock(row: BlockRow): DocumentBlock {
  return DocumentBlockSchema.parse({
    id: row.id,
    parseRunId: row.parse_run_id,
    documentVersionId: row.document_version_id,
    contentRevision: row.content_revision,
    ordinal: row.ordinal,
    type: row.block_type,
    text: row.text_content,
    originalText: row.original_text,
    pageNo: row.page_no,
    sheetName: row.sheet_name,
    slideNo: row.slide_no,
    bbox: row.bbox,
    headingLevel: row.heading_level,
    parentBlockId: row.parent_block_id,
    confidence: row.confidence === null ? null : Number(row.confidence),
    table: row.table_data,
    parserName: row.parser_name,
    parserRevision: row.parser_revision,
    ocrEngine: row.ocr_engine,
    ocrRevision: row.ocr_revision,
    metadata: row.metadata,
    contentSha256: row.content_sha256,
    createdAt: iso(row.created_at),
  });
}

function mapIssue(row: IssueRow): ParseIssue {
  return ParseIssueSchema.parse({
    id: row.id,
    parseRunId: row.parse_run_id,
    severity: row.severity,
    code: row.code,
    message: row.message,
    pageNo: row.page_no,
    blockId: row.block_id,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
  });
}

function requireRow<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
