/**
 * 总览、队列、告警、Feature Flag 和审计日志的 PostgreSQL Adapter。
 *
 * 所有查询使用固定 SQL 与白名单字段；审计游标是服务端编码的 `(occurredAt,id)`，客户端
 * 不能提交列名或排序表达式。Flag 更新和审计在同一事务，灰度选择使用稳定哈希。
 *
 * @requirement OPS-005
 * @requirement OPS-016
 * @requirement OPS-018
 * @requirement WEB-006
 * @requirement WEB-025
 * @requirement WEB-026
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ApplicationError,
  type AccessContext,
  type AuditLogPage,
  type OperationsRepository,
} from '@rag/application';
import {
  AuditLogEntrySchema,
  FeatureFlagDecisionSchema,
  FeatureFlagSchema,
  IndexReconciliationSummarySchema,
  OperationalAlertSchema,
  PlatformOverviewSchema,
  QueueOperationalSummarySchema,
  SemanticRoleSchema,
  type AuditLogEntry,
  type AuditLogQuery,
  type FeatureFlag,
  type FeatureFlagDecision,
  type IndexReconciliationSummary,
  type OperationalAlert,
  type PlatformOverview,
  type QueueOperationalSummary,
  type UpdateFeatureFlagRequest,
  type UserContext,
} from '@rag/contracts';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

interface AlertRow {
  id: string;
  severity: OperationalAlert['severity'];
  code: string;
  title: string;
  public_message: string;
  resource_type: string;
  resource_id: string | null;
  runbook_key: string;
  status: OperationalAlert['status'];
  occurred_at: Date;
  updated_at: Date;
}

interface FlagRow {
  flag_key: string;
  scope: FeatureFlag['scope'];
  space_id: string | null;
  enabled: boolean;
  rollout_percent: number;
  version: number;
  reason: string;
  updated_by: string;
  updated_at: Date;
}

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_roles: string[];
  action: string;
  resource_type: string;
  resource_id: string | null;
  result: AuditLogEntry['result'];
  reason: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

/** PostgreSQL 运维控制面事实源。 */
@Injectable()
export class PostgresOperationsRepository implements OperationsRepository {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /** 聚合只计算当前数据库事实；七日趋势使用 UTC 日期。 */
  public async getOverview(context: AccessContext): Promise<PlatformOverview> {
    assertOperationsReader(context);
    const [counts, trend, precision] = await Promise.all([
      this.pool.query<{
        spaces: number;
        documents: number;
        jobs_running: number;
        jobs_failed: number;
        pending_reviews: number;
        published_documents: number;
        questions_24h: number;
        completed_24h: number;
        terminal_24h: number;
      }>(
        `SELECT
          (SELECT count(*)::integer FROM knowledge_spaces WHERE status='ACTIVE') AS spaces,
          (SELECT count(*)::integer FROM documents WHERE status='ACTIVE') AS documents,
          (SELECT count(*)::integer FROM ingestion_jobs WHERE status IN ('QUEUED','RUNNING','WAITING')) AS jobs_running,
          (SELECT count(*)::integer FROM ingestion_jobs WHERE status='FAILED') AS jobs_failed,
          (SELECT count(*)::integer FROM document_quality_reports WHERE review_decision='PENDING') AS pending_reviews,
          (SELECT count(DISTINCT member.document_id)::integer
             FROM manifest_document_members member
             JOIN space_manifest_heads head ON head.active_manifest_id=member.manifest_id) AS published_documents,
          (SELECT count(*)::integer FROM rag_runs WHERE created_at>=now()-interval '24 hours') AS questions_24h,
          (SELECT count(*)::integer FROM rag_runs WHERE created_at>=now()-interval '24 hours' AND status='COMPLETED') AS completed_24h,
          (SELECT count(*)::integer FROM rag_runs WHERE created_at>=now()-interval '24 hours'
             AND status IN ('COMPLETED','FAILED','CANCELLED','EXPIRED')) AS terminal_24h`,
      ),
      this.pool.query<{ day: Date; runs: number; completed: number }>(
        `WITH days AS (
           SELECT generate_series(
             date_trunc('day',now())-interval '6 days',date_trunc('day',now()),interval '1 day'
           ) AS day
         )
         SELECT days.day,count(run.id)::integer AS runs,
                count(run.id) FILTER (WHERE run.status='COMPLETED')::integer AS completed
           FROM days LEFT JOIN rag_runs run
             ON run.created_at>=days.day AND run.created_at<days.day+interval '1 day'
          GROUP BY days.day ORDER BY days.day`,
      ),
      this.pool.query<{ value: number }>(
        `SELECT (metric->>'value')::double precision AS value
           FROM evaluation_runs run
           CROSS JOIN LATERAL jsonb_array_elements(run.metrics) metric
          WHERE run.status='COMPLETED' AND metric->>'name'='CITATION_PRECISION'
          ORDER BY run.completed_at DESC LIMIT 1`,
      ),
    ]);
    const row = required(counts.rows[0], '平台总览查询失败');
    const successRate = row.terminal_24h === 0 ? 0 : row.completed_24h / row.terminal_24h;
    const citationPrecision = precision.rows[0]?.value ?? null;
    return PlatformOverviewSchema.parse({
      spaces: row.spaces,
      documents: row.documents,
      jobsRunning: row.jobs_running,
      jobsFailed: row.jobs_failed,
      pendingReviews: row.pending_reviews,
      publishedDocuments: row.published_documents,
      questions24h: row.questions_24h,
      answerSuccessRate24h: successRate,
      qualityTrend: trend.rows.map((item) => ({
        date: item.day.toISOString().slice(0, 10),
        answerSuccessRate: item.runs === 0 ? 0 : item.completed / item.runs,
        citationPrecision,
        runs: item.runs,
      })),
    });
  }

  /** SQL 事实队列与 Redis/BullMQ 面板互补；即使 Redis 故障仍能看到待处理事实。 */
  public async listQueues(context: AccessContext): Promise<readonly QueueOperationalSummary[]> {
    assertOperationsReader(context);
    const result = await this.pool.query<{
      queue: string;
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
      dlq: number;
      stalled: number;
      oldest_waiting_seconds: number | null;
    }>(
      `SELECT 'ingestion' AS queue,
              count(*) FILTER (WHERE status='QUEUED')::integer AS waiting,
              count(*) FILTER (WHERE status='RUNNING')::integer AS active,
              count(*) FILTER (WHERE status='WAITING')::integer AS delayed,
              count(*) FILTER (WHERE status='FAILED')::integer AS failed,
              count(*) FILTER (WHERE status='REJECTED')::integer AS dlq,
              count(*) FILTER (WHERE status='RUNNING' AND lease_expires_at<now())::integer AS stalled,
              extract(epoch FROM now()-min(created_at) FILTER (WHERE status='QUEUED'))::integer AS oldest_waiting_seconds
         FROM ingestion_jobs
       UNION ALL
       SELECT 'rag-online',
              count(*) FILTER (WHERE status='ACCEPTED')::integer,
              count(*) FILTER (WHERE status IN ('RUNNING','CANCELLING'))::integer,
              0,
              count(*) FILTER (WHERE status='FAILED')::integer,
              0,
              count(*) FILTER (WHERE status='ACCEPTED' AND deadline_at<now())::integer,
              extract(epoch FROM now()-min(created_at) FILTER (WHERE status='ACCEPTED'))::integer
         FROM rag_runs
       UNION ALL
       SELECT 'evaluation-offline',
              count(*) FILTER (WHERE status='QUEUED')::integer,
              count(*) FILTER (WHERE status='RUNNING')::integer,
              0,
              count(*) FILTER (WHERE status='FAILED')::integer,
              count(*) FILTER (WHERE status='ERROR')::integer,
              count(*) FILTER (WHERE status='RUNNING' AND lease_expires_at<now())::integer,
              extract(epoch FROM now()-min(created_at) FILTER (WHERE status='QUEUED'))::integer
         FROM evaluation_case_results
       UNION ALL
       SELECT 'rag-sse-outbox',
              count(*) FILTER (WHERE published_at IS NULL AND available_at<=now()
                                AND (locked_until IS NULL OR locked_until<=now()))::integer,
              count(*) FILTER (WHERE published_at IS NULL AND locked_until>now())::integer,
              count(*) FILTER (WHERE published_at IS NULL AND available_at>now())::integer,
              count(*) FILTER (WHERE published_at IS NULL AND last_error_code IS NOT NULL)::integer,
              count(*) FILTER (WHERE published_at IS NULL AND attempts>=10)::integer,
              count(*) FILTER (WHERE published_at IS NULL AND locked_by IS NOT NULL
                                AND locked_until<=now())::integer,
              extract(epoch FROM now()-min(occurred_at)
                FILTER (WHERE published_at IS NULL))::integer
         FROM rag_run_event_outbox`,
    );
    return result.rows.map((row) =>
      QueueOperationalSummarySchema.parse({
        queue: row.queue,
        waiting: row.waiting,
        active: row.active,
        delayed: row.delayed,
        failed: row.failed,
        dlq: row.dlq,
        stalled: row.stalled,
        oldestWaitingSeconds: row.oldest_waiting_seconds,
      }),
    );
  }

  /** 最近五十次索引对账只返回计数、结果和不可变摘要，不返回 Chunk 或问题正文。 */
  public async listReconciliations(
    context: AccessContext,
  ): Promise<readonly IndexReconciliationSummary[]> {
    assertOperationsReader(context);
    const result = await this.pool.query<{
      id: string;
      indexing_run_id: string;
      manifest_id: string;
      expected_count: number;
      actual_count: number;
      checked_primary_keys: number;
      fixed_queries_passed: number;
      issue_count: number;
      passed: boolean;
      report_sha256: string;
      created_at: Date;
    }>(
      `SELECT id,indexing_run_id,manifest_id,expected_count,actual_count,
              checked_primary_keys,fixed_queries_passed,jsonb_array_length(issues)::integer AS issue_count,
              passed,report_sha256,created_at
         FROM index_reconciliation_reports
        ORDER BY created_at DESC,id DESC LIMIT 50`,
    );
    return result.rows.map((row) =>
      IndexReconciliationSummarySchema.parse({
        id: row.id,
        indexingRunId: row.indexing_run_id,
        manifestId: row.manifest_id,
        expectedCount: row.expected_count,
        actualCount: row.actual_count,
        checkedPrimaryKeys: row.checked_primary_keys,
        fixedQueriesPassed: row.fixed_queries_passed,
        issueCount: row.issue_count,
        passed: row.passed,
        reportSha256: row.report_sha256,
        createdAt: row.created_at.toISOString(),
      }),
    );
  }

  /** 最近 200 条告警。 */
  public async listAlerts(context: AccessContext): Promise<readonly OperationalAlert[]> {
    assertOperationsReader(context);
    const result = await this.pool.query<AlertRow>(
      `SELECT * FROM operational_alerts
        ORDER BY CASE status WHEN 'OPEN' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END,
                 occurred_at DESC,id DESC LIMIT 200`,
    );
    return result.rows.map(mapAlert);
  }

  /** 告警动作与审计同事务提交。 */
  public async updateAlert(
    context: AccessContext,
    alertId: string,
    action: 'ACKNOWLEDGE' | 'RESOLVE',
    reason: string,
  ): Promise<OperationalAlert> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<AlertRow>(
        `UPDATE operational_alerts SET status=$3,updated_at=now()
          WHERE id=$1 AND status<>'RESOLVED' RETURNING *`,
        [alertId, context.user.userId, action === 'ACKNOWLEDGE' ? 'ACKNOWLEDGED' : 'RESOLVED'],
      );
      const alert = required(result.rows[0], '告警不存在或已解决');
      await appendAudit(client, context, `ALERT_${action}`, 'OPERATIONAL_ALERT', alertId, reason);
      await client.query('COMMIT');
      return mapAlert(alert);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Flag 稳定排序。 */
  public async listFeatureFlags(context: AccessContext): Promise<readonly FeatureFlag[]> {
    assertOperationsReader(context);
    const result = await this.pool.query<FlagRow>(
      'SELECT * FROM feature_flags ORDER BY flag_key,scope,space_id NULLS FIRST',
    );
    return result.rows.map(mapFlag);
  }

  /** 乐观锁更新 Flag 和审计。 */
  public async updateFeatureFlag(
    context: AccessContext,
    flagKey: string,
    spaceId: string | null,
    request: UpdateFeatureFlagRequest,
  ): Promise<FeatureFlag> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<FlagRow>(
        `UPDATE feature_flags SET enabled=$3,rollout_percent=$4,reason=$5,updated_by=$6,
                version=version+1,updated_at=now()
          WHERE flag_key=$1 AND space_id IS NOT DISTINCT FROM $2 AND version=$7 RETURNING *`,
        [
          flagKey,
          spaceId,
          request.enabled,
          request.rolloutPercent,
          request.reason,
          context.user.userId,
          request.expectedVersion,
        ],
      );
      const row = result.rows[0];
      if (!row)
        throw new ApplicationError('VERSION_CONFLICT', 409, 'Feature Flag 版本冲突或不存在');
      await appendAudit(
        client,
        context,
        'FEATURE_FLAG_UPDATE',
        'FEATURE_FLAG',
        flagKey,
        request.reason,
      );
      await client.query('COMMIT');
      return mapFlag(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 对系统和指定空间 Flag 做稳定灰度判定，返回值随后进入 Run 快照。 */
  public async resolveFeatureFlags(
    user: UserContext,
    spaceIds: readonly string[],
  ): Promise<readonly FeatureFlagDecision[]> {
    const result = await this.pool.query<FlagRow>(
      `SELECT * FROM feature_flags
        WHERE scope='SYSTEM' OR (scope='SPACE' AND space_id=ANY($1::uuid[]))
        ORDER BY flag_key,scope,space_id NULLS FIRST`,
      [spaceIds],
    );
    return result.rows.map((row) =>
      FeatureFlagDecisionSchema.parse({
        key: row.flag_key,
        enabled:
          row.enabled &&
          stableBucket(`${user.userId}:${row.flag_key}:${row.space_id ?? 'system'}`) <
            row.rollout_percent,
        version: row.version,
        scope: row.scope,
        spaceId: row.space_id,
      }),
    );
  }

  /** 固定字段过滤与 `(occurred_at,id)` 降序游标分页。 */
  public async listAuditLogs(context: AccessContext, query: AuditLogQuery): Promise<AuditLogPage> {
    assertOperationsReader(context);
    // AuditLogQuery 是 Zod 输入类型，默认值要到 HTTP 边界 parse 后才存在；
    // Repository 仍提供安全默认值，避免内部调用漏传时生成无界查询。
    const limit = typeof query.limit === 'number' ? query.limit : 50;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const result = await this.pool.query<AuditRow>(
      `SELECT * FROM audit_logs
        WHERE ($1::text IS NULL OR actor_user_id=$1)
          AND ($2::text IS NULL OR actor_roles @> ARRAY[$2]::text[])
          AND ($3::text IS NULL OR action=$3)
          AND ($4::text IS NULL OR resource_type=$4)
          AND ($5::text IS NULL OR result=$5)
          AND ($6::timestamptz IS NULL OR occurred_at >= $6)
          AND ($7::timestamptz IS NULL OR occurred_at <= $7)
          AND ($8::timestamptz IS NULL OR (occurred_at,id) < ($8::timestamptz,$9::uuid))
        ORDER BY occurred_at DESC,id DESC LIMIT $10`,
      [
        query.userId ?? null,
        query.role ?? null,
        query.action ?? null,
        query.resourceType ?? null,
        query.result ?? null,
        query.from ?? null,
        query.to ?? null,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    const hasMore = result.rows.length > limit;
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(mapAudit),
      nextCursor: hasMore && last ? encodeCursor(last.occurred_at, last.id) : null,
    };
  }

  /** 导出复用相同过滤并使用硬上限，不接受 cursor。 */
  public async exportAuditLogs(
    context: AccessContext,
    query: AuditLogQuery,
  ): Promise<readonly AuditLogEntry[]> {
    assertOperationsReader(context);
    const result = await this.pool.query<AuditRow>(
      `SELECT * FROM audit_logs
        WHERE ($1::text IS NULL OR actor_user_id=$1)
          AND ($2::text IS NULL OR actor_roles @> ARRAY[$2]::text[])
          AND ($3::text IS NULL OR action=$3)
          AND ($4::text IS NULL OR resource_type=$4)
          AND ($5::text IS NULL OR result=$5)
          AND ($6::timestamptz IS NULL OR occurred_at >= $6)
          AND ($7::timestamptz IS NULL OR occurred_at <= $7)
        ORDER BY occurred_at DESC,id DESC LIMIT 10000`,
      [
        query.userId ?? null,
        query.role ?? null,
        query.action ?? null,
        query.resourceType ?? null,
        query.result ?? null,
        query.from ?? null,
        query.to ?? null,
      ],
    );
    await appendAudit(
      this.pool,
      context,
      'AUDIT_EXPORT',
      'EXPORT',
      context.requestId,
      '脱敏审计导出',
    );
    return result.rows.map(mapAudit);
  }
}

function mapAlert(row: AlertRow): OperationalAlert {
  return OperationalAlertSchema.parse({
    id: row.id,
    severity: row.severity,
    code: row.code,
    title: row.title,
    publicMessage: row.public_message,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    runbookKey: row.runbook_key,
    status: row.status,
    occurredAt: row.occurred_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapFlag(row: FlagRow): FeatureFlag {
  return FeatureFlagSchema.parse({
    key: row.flag_key,
    scope: row.scope,
    spaceId: row.space_id,
    enabled: row.enabled,
    rolloutPercent: row.rollout_percent,
    version: row.version,
    reason: row.reason,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapAudit(row: AuditRow): AuditLogEntry {
  const metadata = Object.fromEntries(
    Object.entries(row.metadata).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        ['string', 'number', 'boolean'].includes(typeof entry[1]) || entry[1] === null,
    ),
  );
  return AuditLogEntrySchema.parse({
    id: row.id,
    userId: row.actor_user_id ?? 'anonymous',
    roles: row.actor_roles
      .map((role) => SemanticRoleSchema.safeParse(role))
      .filter((item) => item.success)
      .map((item) => item.data),
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    result: row.result,
    reason: row.reason,
    metadata,
    occurredAt: row.occurred_at.toISOString(),
  });
}

function stableBucket(value: string): number {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) % 100;
}

function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ occurredAt: occurredAt.toISOString(), id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(value: string): { occurredAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      occurredAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.occurredAt !== 'string' || typeof parsed.id !== 'string') throw new Error();
    return { occurredAt: parsed.occurredAt, id: parsed.id };
  } catch {
    throw new ApplicationError('INVALID_STATE', 409, '审计游标非法');
  }
}

async function appendAudit(
  client: Pool | PoolClient,
  context: AccessContext,
  action: string,
  resourceType: string,
  resourceId: string,
  reason: string,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (
       actor_user_id,actor_roles,authz_version,action,resource_type,resource_id,
       result,reason,request_id,trace_id
     ) VALUES ($1,$2,$3,$4,$5,$6,'SUCCESS',$7,$8,$9)`,
    [
      context.user.userId,
      context.user.roles,
      context.user.authzVersion,
      action,
      resourceType,
      resourceId,
      reason,
      context.requestId,
      context.traceId ?? null,
    ],
  );
}

function assertOperationsReader(context: AccessContext): void {
  if (
    !context.user.roles.some((role) =>
      ['SYSTEM_ADMIN', 'KNOWLEDGE_ADMIN', 'AUDITOR'].includes(role),
    )
  ) {
    throw new ApplicationError('ACCESS_DENIED', 403, '当前角色不能读取运维事实');
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new ApplicationError('NOT_FOUND', 404, message);
  return value;
}
