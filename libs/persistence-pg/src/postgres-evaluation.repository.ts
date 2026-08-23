/**
 * 评测集、运行、Case 租约、结果和基线的 PostgreSQL Adapter。
 *
 * 数据集与运行均为不可变版本事实；Worker 使用 `FOR UPDATE SKIP LOCKED` 领取 Case，
 * 完成 Case 和刷新运行计数位于同一事务。此 Adapter 只返回脱敏评测事实，不解密问答正文。
 *
 * @requirement OPS-001
 * @requirement OPS-003
 * @requirement OPS-004
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ApplicationError,
  type AccessContext,
  type ClaimedEvaluationCase,
  type CreateEvaluationDatasetCommand,
  type CreateEvaluationRunCommand,
  type EvaluationRepository,
  type ReadyEvaluationRun,
} from '@rag/application';
import {
  EvaluationActualSchema,
  EvaluationBaselineSchema,
  EvaluationCaseResultSchema,
  EvaluationCaseSchema,
  EvaluationDatasetSchema,
  EvaluationExpectationSchema,
  EvaluationMetricSchema,
  EvaluationRunSchema,
  EvaluationSnapshotSchema,
  SemanticRoleSchema,
  type EvaluationActual,
  type EvaluationBaseline,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationDataset,
  type EvaluationMetric,
  type EvaluationRun,
  type EvaluationRunDetail,
} from '@rag/contracts';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { z } from 'zod';
import { POSTGRES_POOL } from './postgres.tokens';

interface DatasetRow {
  id: string;
  name: string;
  description: string;
  version: string;
  status: EvaluationDataset['status'];
  case_count: string | number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface CaseRow {
  id: string;
  dataset_id: string;
  ordinal: number;
  external_key: string;
  title: string;
  dimension: EvaluationCase['dimension'];
  question: string | null;
  requested_space_ids: string[];
  document_version_id: string | null;
  processing_run_id: string | null;
  expectation: unknown;
  fixture_actual: unknown | null;
  tags: string[];
  created_at: Date;
}

interface RunRow {
  id: string;
  dataset_id: string;
  dataset_name: string;
  dataset_version: string;
  baseline_id: string | null;
  status: EvaluationRun['status'];
  snapshot: unknown;
  metrics: unknown;
  regressions: unknown;
  total_cases: number;
  completed_cases: number;
  passed_cases: number;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface ResultRow {
  id: string;
  evaluation_run_id: string;
  case_id: string;
  rag_run_id: string | null;
  status: EvaluationCaseResult['status'];
  actual: unknown | null;
  scores: Record<string, unknown>;
  failure_codes: string[];
  duration_ms: number | null;
  created_at: Date;
  completed_at: Date | null;
}

interface BaselineRow {
  id: string;
  name: string;
  evaluation_run_id: string;
  dataset_id: string;
  snapshot: unknown;
  metrics: unknown;
  created_by: string;
  created_at: Date;
}

interface ClaimedRow extends CaseRow {
  result_id: string;
  evaluation_run_id: string;
  rag_run_id: string | null;
  owner_user_id: string;
  owner_roles: string[];
  owner_authz_version: string | number;
  owner_roles_sha256: string;
  attempts: number;
}

/** PostgreSQL 评测事实源。 */
@Injectable()
export class PostgresEvaluationRepository implements EvaluationRepository {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /** 数据集与全部 Case 在同一事务创建，避免出现“空壳版本”。 */
  public async createDataset(
    context: AccessContext,
    command: CreateEvaluationDatasetCommand,
  ): Promise<EvaluationDataset> {
    assertReader(context, true);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<Omit<DatasetRow, 'case_count'>>(
        `INSERT INTO evaluation_datasets (
           name, description, version, created_by, creator_roles, creator_authz_version
         ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          command.name,
          command.description,
          command.version,
          command.createdBy,
          command.creatorRoles,
          command.creatorAuthzVersion,
        ],
      );
      const dataset = required(inserted.rows[0], '评测集创建失败');
      for (const [index, item] of command.cases.entries()) {
        await client.query(
          `INSERT INTO evaluation_cases (
             dataset_id, ordinal, external_key, title, dimension, question,
             requested_space_ids, document_version_id, processing_run_id,
             expectation, fixture_actual, tags
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9,$10::jsonb,$11::jsonb,$12::text[])`,
          [
            dataset.id,
            index + 1,
            item.externalKey,
            item.title,
            item.dimension,
            item.question ?? null,
            item.requestedSpaceIds,
            item.documentVersionId ?? null,
            item.processingRunId ?? null,
            JSON.stringify(EvaluationExpectationSchema.parse(item.expectation)),
            item.fixtureActual
              ? JSON.stringify(EvaluationActualSchema.parse(item.fixtureActual))
              : null,
            item.tags,
          ],
        );
      }
      await client.query('COMMIT');
      return mapDataset({ ...dataset, case_count: command.cases.length });
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) {
        throw new ApplicationError('VERSION_CONFLICT', 409, '同名评测集版本已存在');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** 激活一个版本时归档同名旧版本，切换在单事务内完成。 */
  public async activateDataset(
    context: AccessContext,
    datasetId: string,
  ): Promise<EvaluationDataset> {
    assertReader(context, true);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<Omit<DatasetRow, 'case_count'>>(
        'SELECT * FROM evaluation_datasets WHERE id = $1 FOR UPDATE',
        [datasetId],
      );
      const row = required(current.rows[0], '评测集不存在');
      await client.query(
        `UPDATE evaluation_datasets SET status='ARCHIVED', updated_at=now()
          WHERE name=$1 AND status='ACTIVE' AND id<>$2`,
        [row.name, row.id],
      );
      const updated = await client.query<Omit<DatasetRow, 'case_count'>>(
        `UPDATE evaluation_datasets SET status='ACTIVE', updated_at=now()
          WHERE id=$1 AND status IN ('DRAFT','ACTIVE') RETURNING *`,
        [datasetId],
      );
      const active = required(updated.rows[0], '已归档评测集不能重新激活');
      const count = await caseCount(client, datasetId);
      await client.query('COMMIT');
      return mapDataset({ ...active, case_count: count });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 最近版本优先，列表有固定上限。 */
  public async listDatasets(context: AccessContext): Promise<readonly EvaluationDataset[]> {
    assertReader(context);
    const result = await this.pool.query<DatasetRow>(
      `SELECT dataset.*, count(case_record.id)::integer AS case_count
         FROM evaluation_datasets dataset
         LEFT JOIN evaluation_cases case_record ON case_record.dataset_id=dataset.id
        GROUP BY dataset.id ORDER BY dataset.updated_at DESC, dataset.id DESC LIMIT 200`,
    );
    return result.rows.map(mapDataset);
  }

  /** 读取单个数据集。 */
  public async getDataset(context: AccessContext, datasetId: string): Promise<EvaluationDataset> {
    assertReader(context);
    const result = await this.pool.query<DatasetRow>(
      `SELECT dataset.*, count(case_record.id)::integer AS case_count
         FROM evaluation_datasets dataset
         LEFT JOIN evaluation_cases case_record ON case_record.dataset_id=dataset.id
        WHERE dataset.id=$1 GROUP BY dataset.id`,
      [datasetId],
    );
    return mapDataset(required(result.rows[0], '评测集不存在'));
  }

  /** Case 按 ordinal 稳定返回。 */
  public async listCases(
    context: AccessContext,
    datasetId: string,
  ): Promise<readonly EvaluationCase[]> {
    assertReader(context);
    const result = await this.pool.query<CaseRow>(
      'SELECT * FROM evaluation_cases WHERE dataset_id=$1 ORDER BY ordinal',
      [datasetId],
    );
    return result.rows.map(mapCase);
  }

  /** 解析数据集中涉及空间的当前 Active Manifest，创建 Run 时随后固化。 */
  public async resolveManifestIds(
    context: AccessContext,
    datasetId: string,
  ): Promise<readonly string[]> {
    assertReader(context, true);
    const result = await this.pool.query<{ manifest_id: string }>(
      `SELECT DISTINCT head.active_manifest_id AS manifest_id
         FROM evaluation_cases case_record
         CROSS JOIN LATERAL unnest(case_record.requested_space_ids) requested(space_id)
         JOIN space_manifest_heads head ON head.space_id=requested.space_id
        WHERE case_record.dataset_id=$1 ORDER BY head.active_manifest_id`,
      [datasetId],
    );
    return result.rows.map((row) => row.manifest_id);
  }

  /** 创建运行和所有 QUEUED 结果行，后续只允许 Worker 推进。 */
  public async createRun(
    context: AccessContext,
    command: CreateEvaluationRunCommand,
  ): Promise<EvaluationRun> {
    assertReader(context, true);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const datasetResult = await client.query<{
        id: string;
        name: string;
        version: string;
        status: EvaluationDataset['status'];
      }>('SELECT id,name,version,status FROM evaluation_datasets WHERE id=$1 FOR SHARE', [
        command.datasetId,
      ]);
      const dataset = required(datasetResult.rows[0], '评测集不存在');
      if (dataset.status !== 'ACTIVE') {
        throw new ApplicationError('INVALID_STATE', 409, '只有 ACTIVE 评测集可以执行');
      }
      if (command.baselineId) {
        const compatible = await client.query<{ exists: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM evaluation_baselines WHERE id=$1 AND dataset_id=$2) AS exists',
          [command.baselineId, command.datasetId],
        );
        if (!compatible.rows[0]?.exists) {
          throw new ApplicationError('VERSION_CONFLICT', 409, '基线与评测集不匹配');
        }
      }
      const total = await caseCount(client, command.datasetId);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO evaluation_runs (
           dataset_id, baseline_id, snapshot, total_cases, created_by,
           creator_roles, creator_authz_version, creator_roles_sha256, note
         ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          command.datasetId,
          command.baselineId ?? null,
          JSON.stringify(command.snapshot),
          total,
          command.createdBy,
          command.creatorRoles,
          command.creatorAuthzVersion,
          rolesHash(command.creatorRoles),
          command.note ?? null,
        ],
      );
      const runId = required(inserted.rows[0], '评测运行创建失败').id;
      await client.query(
        `INSERT INTO evaluation_case_results (evaluation_run_id, case_id)
         SELECT $1,id FROM evaluation_cases WHERE dataset_id=$2 ORDER BY ordinal`,
        [runId, command.datasetId],
      );
      await client.query('COMMIT');
      return mapRun(required((await this.queryRun(runId)).rows[0], '评测运行创建后读取失败'));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 最近运行列表。 */
  public async listRuns(context: AccessContext): Promise<readonly EvaluationRun[]> {
    assertReader(context);
    const result = await this.queryRun();
    return result.rows.map(mapRun);
  }

  /** 运行详情最多暴露 200 个失败优先结果。 */
  public async getRunDetail(context: AccessContext, runId: string): Promise<EvaluationRunDetail> {
    assertReader(context);
    const run = mapRun(required((await this.queryRun(runId)).rows[0], '评测运行不存在'));
    const [results, baseline] = await Promise.all([
      this.pool.query<ResultRow>(
        `SELECT * FROM evaluation_case_results WHERE evaluation_run_id=$1
          ORDER BY CASE status WHEN 'ERROR' THEN 0 WHEN 'FAILED' THEN 1 ELSE 2 END,
                   created_at,id LIMIT 200`,
        [runId],
      ),
      run.baselineId
        ? this.pool.query<BaselineRow>('SELECT * FROM evaluation_baselines WHERE id=$1', [
            run.baselineId,
          ])
        : Promise.resolve({ rows: [] as BaselineRow[] }),
    ]);
    const regressionResult = await this.pool.query<{ regressions: unknown }>(
      'SELECT regressions FROM evaluation_runs WHERE id=$1',
      [runId],
    );
    return {
      run,
      results: results.rows.map(mapResult),
      baseline: baseline.rows[0] ? mapBaseline(baseline.rows[0]) : null,
      regressions: z.array(z.string()).parse(regressionResult.rows[0]?.regressions ?? []),
    };
  }

  /** 运行所有门禁通过后才能建立基线，并写安全审计。 */
  public async promoteBaseline(
    context: AccessContext,
    runId: string,
    name: string,
    reason: string,
  ): Promise<EvaluationBaseline> {
    assertReader(context, true);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const runResult = await this.queryRun(runId, client, true);
      const run = mapRun(required(runResult.rows[0], '评测运行不存在'));
      if (
        run.status !== 'COMPLETED' ||
        run.metrics.length === 0 ||
        run.metrics.some((metric) => !metric.passed)
      ) {
        throw new ApplicationError('INVALID_STATE', 409, '只有全部质量门禁通过的运行才能提升基线');
      }
      const inserted = await client.query<BaselineRow>(
        `INSERT INTO evaluation_baselines (
           name,evaluation_run_id,dataset_id,snapshot,metrics,created_by,reason
         ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7) RETURNING *`,
        [
          name,
          run.id,
          run.datasetId,
          JSON.stringify(run.snapshot),
          JSON.stringify(run.metrics),
          context.user.userId,
          reason,
        ],
      );
      await appendAudit(
        client,
        context,
        'EVALUATION_BASELINE_PROMOTE',
        'EVALUATION_RUN',
        runId,
        reason,
      );
      await client.query('COMMIT');
      return mapBaseline(required(inserted.rows[0], '基线创建失败'));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 领取 QUEUED 或等待 RagRun 终态的 RUNNING Case。 */
  public async claimCases(
    workerId: string,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<readonly ClaimedEvaluationCase[]> {
    const claimed = await this.pool.query<{ id: string }>(
      `WITH candidates AS (
         SELECT result.id FROM evaluation_case_results result
         JOIN evaluation_runs run ON run.id=result.evaluation_run_id
          WHERE run.status IN ('QUEUED','RUNNING')
            AND result.status IN ('QUEUED','RUNNING')
            AND result.available_at <= now()
            AND (result.lease_expires_at IS NULL OR result.lease_expires_at < now())
          ORDER BY result.created_at,result.id
          FOR UPDATE OF result SKIP LOCKED LIMIT $1
       )
       UPDATE evaluation_case_results result SET
         status='RUNNING', lease_owner=$2,
         lease_expires_at=now()+($3::text||' seconds')::interval, updated_at=now()
       FROM candidates WHERE result.id=candidates.id RETURNING result.id`,
      [batchSize, workerId, leaseSeconds],
    );
    if (claimed.rows.length === 0) return [];
    await this.pool.query(
      `UPDATE evaluation_runs SET status='RUNNING', started_at=COALESCE(started_at,now()), updated_at=now()
        WHERE id IN (SELECT evaluation_run_id FROM evaluation_case_results WHERE id=ANY($1::uuid[]))
          AND status='QUEUED'`,
      [claimed.rows.map((row) => row.id)],
    );
    const rows = await this.pool.query<ClaimedRow>(
      `SELECT case_record.*, result.id AS result_id, result.evaluation_run_id,
              result.rag_run_id, result.attempts,
              run.created_by AS owner_user_id, run.creator_roles AS owner_roles,
              run.creator_authz_version AS owner_authz_version,
              run.creator_roles_sha256 AS owner_roles_sha256
         FROM evaluation_case_results result
         JOIN evaluation_cases case_record ON case_record.id=result.case_id
         JOIN evaluation_runs run ON run.id=result.evaluation_run_id
        WHERE result.id=ANY($1::uuid[]) AND result.lease_owner=$2
        ORDER BY case_record.ordinal`,
      [claimed.rows.map((row) => row.id), workerId],
    );
    return rows.rows.map((row) => ({
      resultId: row.result_id,
      evaluationRunId: row.evaluation_run_id,
      testCase: mapCase(row),
      ...(row.fixture_actual
        ? { fixtureActual: EvaluationActualSchema.parse(row.fixture_actual) }
        : {}),
      ragRunId: row.rag_run_id,
      ownerUserId: row.owner_user_id,
      ownerRoles: row.owner_roles.map((role) => SemanticRoleSchema.parse(role)),
      ownerAuthzVersion: Number(row.owner_authz_version),
      ownerRolesSha256: row.owner_roles_sha256,
      attempts: row.attempts,
    }));
  }

  /** 关联真实 RagRun 后释放租约，后续 Tick 只轮询事实状态。 */
  public async attachRagRun(resultId: string, workerId: string, ragRunId: string): Promise<void> {
    await requireAffected(
      this.pool.query(
        `UPDATE evaluation_case_results SET rag_run_id=$3, available_at=now()+interval '1 second',
                lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE id=$1 AND lease_owner=$2 AND status='RUNNING'`,
        [resultId, workerId, ragRunId],
      ),
    );
  }

  /** RagRun 未终态时延后，不增加失败次数。 */
  public async releaseCase(
    resultId: string,
    workerId: string,
    delaySeconds: number,
  ): Promise<void> {
    await requireAffected(
      this.pool.query(
        `UPDATE evaluation_case_results SET available_at=now()+($3::text||' seconds')::interval,
                lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE id=$1 AND lease_owner=$2 AND status='RUNNING'`,
        [resultId, workerId, delaySeconds],
      ),
    );
  }

  /** 保存单 Case 结果并在同事务刷新运行计数。 */
  public async completeCase(
    resultId: string,
    workerId: string,
    actual: EvaluationActual,
    scores: Readonly<Record<string, number>>,
    failureCodes: readonly string[],
    passed: boolean,
    durationMs: number,
  ): Promise<EvaluationCaseResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<ResultRow>(
        `UPDATE evaluation_case_results SET status=$3,actual=$4::jsonb,scores=$5::jsonb,
                failure_codes=$6::text[],duration_ms=$7,completed_at=now(),
                lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE id=$1 AND lease_owner=$2 AND status='RUNNING' RETURNING *`,
        [
          resultId,
          workerId,
          passed ? 'PASSED' : 'FAILED',
          JSON.stringify(actual),
          JSON.stringify(scores),
          failureCodes,
          durationMs,
        ],
      );
      const row = required(updated.rows[0], '评测 Case 租约已失效');
      await refreshRunCounts(client, row.evaluation_run_id);
      await client.query('COMMIT');
      return mapResult(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 可重试错误回到队列；终止错误进入 ERROR 并计入已完成。 */
  public async failCase(
    resultId: string,
    workerId: string,
    code: string,
    terminal: boolean,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<{ evaluation_run_id: string }>(
        `UPDATE evaluation_case_results SET status=$3,
                attempts=attempts+1,failure_codes=array_append(failure_codes,$4),
                available_at=CASE WHEN $5 THEN available_at ELSE now()+interval '5 seconds' END,
                completed_at=CASE WHEN $5 THEN now() ELSE NULL END,
                lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE id=$1 AND lease_owner=$2 AND status='RUNNING' RETURNING evaluation_run_id`,
        [resultId, workerId, terminal ? 'ERROR' : 'QUEUED', code, terminal],
      );
      const row = required(updated.rows[0], '评测 Case 租约已失效');
      if (terminal) await refreshRunCounts(client, row.evaluation_run_id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 只有全部 Case 进入终态的 Run 才能领取聚合租约。 */
  public async claimReadyRuns(
    workerId: string,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<readonly ReadyEvaluationRun[]> {
    const claimed = await this.pool.query<{ id: string }>(
      `WITH candidates AS (
         SELECT id FROM evaluation_runs
          WHERE status='RUNNING' AND completed_cases=total_cases
            AND (lease_expires_at IS NULL OR lease_expires_at < now())
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE evaluation_runs run SET lease_owner=$2,
         lease_expires_at=now()+($3::text||' seconds')::interval,updated_at=now()
       FROM candidates WHERE run.id=candidates.id RETURNING run.id`,
      [batchSize, workerId, leaseSeconds],
    );
    const output: ReadyEvaluationRun[] = [];
    for (const item of claimed.rows) {
      const run = mapRun(required((await this.queryRun(item.id)).rows[0], '评测运行不存在'));
      const [scores, baseline] = await Promise.all([
        this.pool.query<{ id: string; status: string; scores: Record<string, number> }>(
          'SELECT id,status,scores FROM evaluation_case_results WHERE evaluation_run_id=$1 ORDER BY id',
          [item.id],
        ),
        run.baselineId
          ? this.pool.query<BaselineRow>('SELECT * FROM evaluation_baselines WHERE id=$1', [
              run.baselineId,
            ])
          : Promise.resolve({ rows: [] as BaselineRow[] }),
      ]);
      output.push({
        run,
        scores: scores.rows.map((row) => ({
          resultId: row.id,
          passed: row.status === 'PASSED',
          scores: row.scores,
        })),
        baseline: baseline.rows[0] ? mapBaseline(baseline.rows[0]) : null,
      });
    }
    return output;
  }

  /** 聚合终态写入后释放租约；运行是否过门禁由 metrics.passed 表达。 */
  public async finalizeRun(
    runId: string,
    workerId: string,
    metrics: readonly EvaluationMetric[],
    regressions: readonly string[],
  ): Promise<void> {
    await requireAffected(
      this.pool.query(
        `UPDATE evaluation_runs SET status='COMPLETED',metrics=$3::jsonb,regressions=$4::jsonb,
                completed_at=now(),lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE id=$1 AND lease_owner=$2 AND status='RUNNING'`,
        [runId, workerId, JSON.stringify(metrics), JSON.stringify(regressions)],
      ),
    );
  }

  private queryRun(
    runId?: string,
    client: Pool | PoolClient = this.pool,
    lock = false,
  ): Promise<QueryResult<RunRow>> {
    return client.query<RunRow>(
      `SELECT run.*,dataset.name AS dataset_name,dataset.version AS dataset_version
         FROM evaluation_runs run JOIN evaluation_datasets dataset ON dataset.id=run.dataset_id
        ${runId ? 'WHERE run.id=$1' : ''}
        ORDER BY run.created_at DESC,run.id DESC ${lock ? 'FOR UPDATE OF run' : ''}
        ${runId ? '' : 'LIMIT 200'}`,
      runId ? [runId] : [],
    );
  }
}

function mapDataset(row: DatasetRow): EvaluationDataset {
  return EvaluationDatasetSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    status: row.status,
    caseCount: Number(row.case_count),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapCase(row: CaseRow): EvaluationCase {
  return EvaluationCaseSchema.parse({
    id: row.id,
    datasetId: row.dataset_id,
    ordinal: row.ordinal,
    externalKey: row.external_key,
    title: row.title,
    dimension: row.dimension,
    ...(row.question ? { question: row.question } : {}),
    requestedSpaceIds: row.requested_space_ids,
    ...(row.document_version_id ? { documentVersionId: row.document_version_id } : {}),
    ...(row.processing_run_id ? { processingRunId: row.processing_run_id } : {}),
    expectation: row.expectation,
    tags: row.tags,
    hasFixtureActual: row.fixture_actual !== null,
    createdAt: row.created_at.toISOString(),
  });
}

function mapRun(row: RunRow): EvaluationRun {
  return EvaluationRunSchema.parse({
    id: row.id,
    datasetId: row.dataset_id,
    datasetName: row.dataset_name,
    datasetVersion: row.dataset_version,
    baselineId: row.baseline_id,
    status: row.status,
    snapshot: EvaluationSnapshotSchema.parse(row.snapshot),
    totalCases: Number(row.total_cases),
    completedCases: Number(row.completed_cases),
    passedCases: Number(row.passed_cases),
    metrics: z.array(EvaluationMetricSchema).parse(row.metrics),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

function mapResult(row: ResultRow): EvaluationCaseResult {
  return EvaluationCaseResultSchema.parse({
    id: row.id,
    evaluationRunId: row.evaluation_run_id,
    caseId: row.case_id,
    ragRunId: row.rag_run_id,
    status: row.status,
    scores: row.scores,
    failureCodes: row.failure_codes,
    actual: row.actual,
    durationMs: row.duration_ms,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

function mapBaseline(row: BaselineRow): EvaluationBaseline {
  return EvaluationBaselineSchema.parse({
    id: row.id,
    name: row.name,
    evaluationRunId: row.evaluation_run_id,
    datasetId: row.dataset_id,
    snapshot: row.snapshot,
    metrics: row.metrics,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  });
}

async function caseCount(client: PoolClient, datasetId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    'SELECT count(*) AS count FROM evaluation_cases WHERE dataset_id=$1',
    [datasetId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function refreshRunCounts(client: PoolClient, runId: string): Promise<void> {
  await client.query(
    `UPDATE evaluation_runs SET
       completed_cases=facts.completed_cases,passed_cases=facts.passed_cases,updated_at=now()
     FROM (
       SELECT evaluation_run_id,
              count(*) FILTER (WHERE status IN ('PASSED','FAILED','ERROR'))::integer AS completed_cases,
              count(*) FILTER (WHERE status='PASSED')::integer AS passed_cases
         FROM evaluation_case_results WHERE evaluation_run_id=$1 GROUP BY evaluation_run_id
     ) facts WHERE evaluation_runs.id=facts.evaluation_run_id`,
    [runId],
  );
}

async function appendAudit(
  client: PoolClient,
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

function rolesHash(roles: readonly string[]): string {
  return createHash('sha256')
    .update([...roles].sort().join('\u001f'))
    .digest('hex');
}

function assertReader(context: AccessContext, write = false): void {
  const allowed = write
    ? ['SYSTEM_ADMIN', 'KNOWLEDGE_ADMIN']
    : ['SYSTEM_ADMIN', 'KNOWLEDGE_ADMIN', 'AUDITOR'];
  if (!context.user.roles.some((role) => allowed.includes(role))) {
    throw new ApplicationError('ACCESS_DENIED', 403, '当前角色不能访问评测事实');
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new ApplicationError('NOT_FOUND', 404, message);
  return value;
}

async function requireAffected(result: Promise<{ rowCount: number | null }>): Promise<void> {
  if ((await result).rowCount !== 1)
    throw new ApplicationError('VERSION_CONFLICT', 409, '评测任务租约已失效');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
