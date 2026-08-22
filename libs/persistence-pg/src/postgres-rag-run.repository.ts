/**
 * M06 会话、Run、Step、事件 Outbox、反馈与保留期的 PostgreSQL Adapter。
 *
 * PostgreSQL 是业务终态事实源：幂等键、乐观锁、答案消息与 answer.completed Outbox
 * 都在事务内提交。Redis Stream 故障不会让第二份答案或错误终态覆盖现有事实。
 *
 * @requirement RUN-001
 * @requirement RUN-002
 * @requirement RUN-004
 * @requirement RUN-005
 * @requirement RUN-006
 * @requirement RUN-011
 * @requirement RUN-012
 * @requirement RUN-013
 * @requirement RUN-014
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ApplicationError,
  type AccessContext,
  type CompleteRagRunCommand,
  type ConversationPage,
  type CreateConversationCommand,
  type CreateRagRunCommand,
  type CreateRagRunResult,
  type FinishRagRunStepCommand,
  type RagRunOutboxEvent,
  type RagRunRepository,
  type RunPublicationRoute,
  type StartRagRunStepCommand,
  type StoredConversationMessage,
  type StoredConversationState,
  type UpdateConversationStateCommand,
} from '@rag/application';
import type {
  Conversation,
  CreateMessageFeedbackRequest,
  ListConversationsQuery,
  MessageFeedback,
  RagRun,
  RagRunSnapshot,
  RagRunStep,
  RagRunStepStatus,
} from '@rag/contracts';
import {
  ConversationMessageSchema,
  ConversationSchema,
  ConversationStateSchema,
  MessageFeedbackSchema,
  RagRunEventSchema,
  RagRunSchema,
  RagRunStepSchema,
} from '@rag/contracts';
import {
  assertRagRunStepTransition,
  assertRagRunTransition,
  isTerminalRagRunStatus,
} from '@rag/domain';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

interface ConversationRow {
  id: string;
  owner_user_id: string;
  title: string;
  status: 'ACTIVE' | 'ARCHIVED';
  optimistic_version: string | number;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  run_id: string | null;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  status: 'PENDING' | 'VISIBLE' | 'REDACTED' | 'DELETED';
  content_storage: 'AES_256_GCM' | 'REDACTED' | 'PLAIN';
  content_value: string;
  content_iv: string | null;
  content_auth_tag: string | null;
  content_sha256: string;
  citations_summary: Record<string, unknown> | null;
  created_at: Date;
}

interface StateRow {
  conversation_id: string;
  optimistic_version: string | number;
  summary_storage: 'AES_256_GCM' | 'REDACTED' | 'PLAIN' | null;
  summary_value: string | null;
  summary_iv: string | null;
  summary_auth_tag: string | null;
  summary_sha256: string | null;
  confirmed_entities: unknown;
  recent_citation_ids: string[];
  short_window_message_ids: string[];
  summary_source_space_ids: string[];
  updated_at: Date;
}

interface RunRow {
  id: string;
  conversation_id: string;
  owner_user_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  idempotency_key: string;
  request_sha256: string;
  status: RagRun['status'];
  optimistic_version: string | number;
  snapshot: RagRunSnapshot;
  deadline_at: Date;
  event_expires_at: Date;
  cancel_requested_at: Date | null;
  failure_code: string | null;
  public_message: string;
  answer_sha256: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

interface StepRow {
  id: string;
  run_id: string;
  node_key: string;
  attempt: number;
  status: RagRunStepStatus;
  input_summary: Record<string, unknown>;
  output_summary: Record<string, unknown>;
  duration_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  trace_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

interface OutboxRow {
  event_id: string;
  run_id: string;
  sequence: string | number;
  schema_version: 1;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
}

interface PublicationRow {
  space_id: string;
  authz_policy_version: string | number;
  stable_manifest_id: string;
  stable_manifest_version: number;
  stable_embedding_profile_id: string;
  stable_embedding_model_revision: string;
  stable_collection_name: string;
  candidate_manifest_id: string | null;
  candidate_manifest_version: number | null;
  candidate_embedding_profile_id: string | null;
  candidate_embedding_model_revision: string | null;
  candidate_collection_name: string | null;
  canary_percent: number | null;
  routing_salt: string | null;
}

/** PostgreSQL M06 Repository。 */
@Injectable()
export class PostgresRagRunRepository implements RagRunRepository {
  public constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /** 创建会话及空的短窗口状态。 */
  public async createConversation(
    context: AccessContext,
    command: CreateConversationCommand,
  ): Promise<Conversation> {
    if (context.user.userId !== command.ownerUserId) throw denied();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ConversationRow>(
        `INSERT INTO conversations (owner_user_id, title)
         VALUES ($1,$2) RETURNING *`,
        [command.ownerUserId, command.title],
      );
      const row = requireRow(result.rows[0], '会话创建失败');
      await client.query('INSERT INTO conversation_states (conversation_id) VALUES ($1)', [row.id]);
      await client.query('COMMIT');
      return mapConversation(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 使用不透明游标稳定分页，查询条件始终包含 owner_user_id。 */
  public async listConversations(
    context: AccessContext,
    query: ListConversationsQuery,
  ): Promise<ConversationPage> {
    const cursor = query.cursor ? decodeConversationCursor(query.cursor) : undefined;
    const result = await this.pool.query<ConversationRow>(
      `SELECT * FROM conversations
        WHERE owner_user_id = $1
          AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY updated_at DESC, id DESC LIMIT $4`,
      [context.user.userId, cursor?.updatedAt ?? null, cursor?.id ?? null, query.limit + 1],
    );
    const hasMore = result.rows.length > query.limit;
    const visible = result.rows.slice(0, query.limit);
    const last = visible.at(-1);
    return {
      items: visible.map(mapConversation),
      nextCursor: hasMore && last ? encodeConversationCursor(last) : null,
    };
  }

  /** 不同用户统一返回 404，避免通过响应差异枚举会话。 */
  public async getConversation(
    context: AccessContext,
    conversationId: string,
  ): Promise<Conversation> {
    const result = await this.pool.query<ConversationRow>(
      'SELECT * FROM conversations WHERE id = $1 AND owner_user_id = $2',
      [conversationId, context.user.userId],
    );
    return mapConversation(requireOwnedRow(result.rows[0], '会话不存在'));
  }

  /** 只加载短窗口；密文留给 Application 的合规保护器处理。 */
  public async listMessages(
    context: AccessContext,
    conversationId: string,
    limit: number,
  ): Promise<{
    readonly items: readonly StoredConversationMessage[];
    readonly state: StoredConversationState;
  }> {
    await this.getConversation(context, conversationId);
    const [messages, state] = await Promise.all([
      this.pool.query<MessageRow>(
        `SELECT * FROM (
           SELECT * FROM conversation_messages
            WHERE conversation_id = $1 AND status <> 'DELETED'
            ORDER BY created_at DESC, id DESC LIMIT $2
         ) recent ORDER BY created_at, id`,
        [conversationId, limit],
      ),
      this.pool.query<StateRow>('SELECT * FROM conversation_states WHERE conversation_id = $1', [
        conversationId,
      ]),
    ]);
    return {
      items: messages.rows.map(mapStoredMessage),
      state: mapStoredState(requireRow(state.rows[0], '会话状态不存在')),
    };
  }

  /** Graph 使用 owner + expectedVersion 更新有限会话记忆，防止并发 Run 静默互相覆盖。 */
  public async updateConversationState(
    ownerUserId: string,
    conversationId: string,
    command: UpdateConversationStateCommand,
  ): Promise<StoredConversationState> {
    const result = await this.pool.query<StateRow>(
      `UPDATE conversation_states state SET
         summary_storage = $4, summary_value = $5, summary_iv = $6, summary_auth_tag = $7,
         summary_sha256 = $8, summary_source_space_ids = $9::uuid[], confirmed_entities = $10::jsonb,
         recent_citation_ids = $11::uuid[], summary_retention_expires_at = $12,
         optimistic_version = state.optimistic_version + 1,
         updated_at = now()
       FROM conversations conversation
       WHERE state.conversation_id = conversation.id
         AND conversation.id = $1 AND conversation.owner_user_id = $2
         AND state.optimistic_version = $3
       RETURNING state.*`,
      [
        conversationId,
        ownerUserId,
        command.expectedVersion,
        command.summary?.storage ?? null,
        command.summary?.value ?? null,
        command.summary?.iv ?? null,
        command.summary?.authTag ?? null,
        command.summary?.sha256 ?? null,
        command.summarySourceSpaceIds,
        JSON.stringify(command.confirmedEntities),
        command.recentCitationIds,
        command.retentionExpiresAt,
      ],
    );
    const row = result.rows[0];
    if (row) return mapStoredState(row);
    const ownership = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM conversations WHERE id = $1 AND owner_user_id = $2
       ) AS exists`,
      [conversationId, ownerUserId],
    );
    if (!ownership.rows[0]?.exists) throw new ApplicationError('NOT_FOUND', 404, '会话不存在');
    throw versionConflict();
  }

  /** 读取稳定 Head 和有效 CANARY，不接受客户端 Collection 名。 */
  public async resolvePublicationRoutes(
    spaceIds: readonly string[],
  ): Promise<readonly RunPublicationRoute[]> {
    if (spaceIds.length === 0) return [];
    const result = await this.pool.query<PublicationRow>(
      `SELECT requested.space_id,
              COALESCE(policy.version,0) AS authz_policy_version,
              stable.id AS stable_manifest_id, stable.version AS stable_manifest_version,
              stable.embedding_profile_id AS stable_embedding_profile_id,
              stable.embedding_model_revision AS stable_embedding_model_revision,
              stable.collection_name AS stable_collection_name,
              candidate.id AS candidate_manifest_id, candidate.version AS candidate_manifest_version,
              candidate.embedding_profile_id AS candidate_embedding_profile_id,
              candidate.embedding_model_revision AS candidate_embedding_model_revision,
              candidate.collection_name AS candidate_collection_name,
              canary.canary_percent, canary.routing_salt::text
         FROM unnest($1::uuid[]) WITH ORDINALITY requested(space_id, ordinal)
         JOIN knowledge_spaces space ON space.id = requested.space_id AND space.status = 'ACTIVE'
         JOIN space_manifest_heads head ON head.space_id = requested.space_id
         JOIN space_manifests stable ON stable.id = head.active_manifest_id AND stable.status = 'ACTIVE'
         LEFT JOIN space_manifest_canaries canary
           ON canary.space_id = requested.space_id
          AND canary.stable_manifest_id = head.active_manifest_id
         LEFT JOIN space_manifests candidate
           ON candidate.id = canary.candidate_manifest_id AND candidate.status = 'VERIFIED'
         LEFT JOIN LATERAL (
           SELECT version FROM knowledge_space_policies
            WHERE space_id = requested.space_id ORDER BY version DESC LIMIT 1
         ) policy ON true
        ORDER BY requested.ordinal`,
      [spaceIds],
    );
    return result.rows.map((row) => ({
      stable: mapPublication(row, 'stable'),
      ...(row.candidate_manifest_id &&
      row.candidate_manifest_version &&
      row.candidate_embedding_profile_id &&
      row.candidate_embedding_model_revision &&
      row.candidate_collection_name &&
      row.canary_percent &&
      row.routing_salt
        ? {
            candidate: mapPublication(row, 'candidate'),
            canaryPercent: row.canary_percent,
            canarySalt: row.routing_salt,
          }
        : {}),
    }));
  }

  /** 幂等检查在插入用户消息之前完成，重放不会制造第二条消息。 */
  public async createRun(
    context: AccessContext,
    command: CreateRagRunCommand,
  ): Promise<CreateRagRunResult> {
    if (context.user.userId !== command.ownerUserId) throw denied();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 同一用户同一幂等键先取得事务级咨询锁：并发请求会排队，后到者随后读取首个请求的事实并重放。
      // Hash 只用于锁分片，不作为业务唯一性；真正唯一约束仍是 (owner_user_id, idempotency_key)。
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        JSON.stringify([command.ownerUserId, command.idempotencyKey]),
      ]);
      const existing = await client.query<RunRow>(
        'SELECT * FROM rag_runs WHERE owner_user_id = $1 AND idempotency_key = $2 FOR UPDATE',
        [command.ownerUserId, command.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_sha256 !== command.requestSha256) {
          throw new ApplicationError(
            'VERSION_CONFLICT',
            409,
            '相同 Idempotency-Key 已用于不同请求',
          );
        }
        await client.query('COMMIT');
        return { run: mapRun(existing.rows[0]), replayed: true };
      }
      const conversation = await client.query<ConversationRow>(
        `SELECT * FROM conversations
          WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`,
        [command.conversationId, command.ownerUserId],
      );
      const conversationRow = requireOwnedRow(conversation.rows[0], '会话不存在');
      if (conversationRow.status !== 'ACTIVE') {
        throw new ApplicationError('INVALID_STATE', 409, '归档会话不能创建新 Run');
      }
      const messageResult = await client.query<{ id: string }>(
        `INSERT INTO conversation_messages (
           conversation_id, role, status, content_storage, content_value,
           content_iv, content_auth_tag, content_sha256, retention_expires_at
         ) VALUES ($1,'USER','VISIBLE',$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          command.conversationId,
          command.question.storage,
          command.question.value,
          command.question.iv ?? null,
          command.question.authTag ?? null,
          command.question.sha256,
          command.retentionExpiresAt,
        ],
      );
      const userMessageId = requireRow(messageResult.rows[0], '用户消息创建失败').id;
      const runResult = await client.query<RunRow>(
        `INSERT INTO rag_runs (
           conversation_id, owner_user_id, user_message_id, idempotency_key,
           request_sha256, snapshot, deadline_at, event_expires_at, public_message
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'请求已接受，等待执行') RETURNING *`,
        [
          command.conversationId,
          command.ownerUserId,
          userMessageId,
          command.idempotencyKey,
          command.requestSha256,
          JSON.stringify(command.snapshot),
          command.deadlineAt,
          command.eventExpiresAt,
        ],
      );
      const run = requireRow(runResult.rows[0], 'Run 创建失败');
      await client.query('UPDATE conversation_messages SET run_id = $2 WHERE id = $1', [
        userMessageId,
        run.id,
      ]);
      await appendShortWindowMessage(client, command.conversationId, userMessageId);
      await client.query(
        `UPDATE conversations SET last_message_at = now(), updated_at = now(),
                optimistic_version = optimistic_version + 1 WHERE id = $1`,
        [command.conversationId],
      );
      await this.appendEvent(client, run.id, 'run.accepted', {
        status: 'ACCEPTED',
        ...(command.traceId ? { traceId: command.traceId } : {}),
      });
      await client.query('COMMIT');
      return { run: mapRun(run), replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 当前用户 Run 详情。 */
  public async getRun(context: AccessContext, runId: string): Promise<RagRun> {
    return this.getRunByOwner(context.user.userId, runId);
  }

  /** Ticket 兑换后用绑定的 ownerUserId 再读取 PG。 */
  public async getRunByOwner(ownerUserId: string, runId: string): Promise<RagRun> {
    const result = await this.pool.query<RunRow>(
      'SELECT * FROM rag_runs WHERE id = $1 AND owner_user_id = $2',
      [runId, ownerUserId],
    );
    return mapRun(requireOwnedRow(result.rows[0], 'Run 不存在'));
  }

  /** 节点详情也通过 Run owner 过滤。 */
  public async listRunSteps(context: AccessContext, runId: string): Promise<readonly RagRunStep[]> {
    await this.getRun(context, runId);
    const result = await this.pool.query<StepRow>(
      'SELECT * FROM rag_run_steps WHERE run_id = $1 ORDER BY created_at, id',
      [runId],
    );
    return result.rows.map(mapStep);
  }

  /** 取消请求写入 CANCELLING 与顺序事件；终态不可逆。 */
  public async requestCancellation(
    context: AccessContext,
    runId: string,
    reason: string,
  ): Promise<RagRun> {
    return this.withLockedRun(runId, context.user.userId, async (client, row) => {
      if (row.status === 'CANCELLING') return row;
      if (isTerminalRagRunStatus(row.status)) {
        throw new ApplicationError('INVALID_STATE', 409, '终态 Run 不能取消');
      }
      assertRagRunTransition(row.status, 'CANCELLING');
      const updated = await client.query<RunRow>(
        `UPDATE rag_runs SET status = 'CANCELLING', cancel_requested_at = now(),
                cancellation_reason = $3, public_message = '正在取消',
                optimistic_version = optimistic_version + 1, updated_at = now()
          WHERE id = $1 AND optimistic_version = $2 RETURNING *`,
        [runId, Number(row.optimistic_version), reason],
      );
      const next = requireVersionedRow(updated.rows[0]);
      await this.appendEvent(client, runId, 'run.cancel_requested', { status: 'CANCELLING' });
      return next;
    });
  }

  /** Graph Worker 以 owner + optimisticVersion 领取 Run。 */
  public async startRun(
    ownerUserId: string,
    runId: string,
    expectedVersion: number,
  ): Promise<RagRun> {
    return this.withLockedRun(runId, ownerUserId, async (client, row) => {
      if (row.status === 'RUNNING' && Number(row.optimistic_version) === expectedVersion + 1)
        return row;
      if (Number(row.optimistic_version) !== expectedVersion) throw versionConflict();
      if (row.deadline_at.getTime() <= Date.now()) {
        throw new ApplicationError('INVALID_STATE', 409, 'Run Deadline 已到期');
      }
      assertRagRunTransition(row.status, 'RUNNING');
      const result = await client.query<RunRow>(
        `UPDATE rag_runs SET status = 'RUNNING', started_at = COALESCE(started_at,now()),
                public_message = '正在执行', optimistic_version = optimistic_version + 1,
                updated_at = now() WHERE id = $1 AND optimistic_version = $2 RETURNING *`,
        [runId, expectedVersion],
      );
      const next = requireVersionedRow(result.rows[0]);
      await this.appendEvent(client, runId, 'run.started', { status: 'RUNNING' });
      return next;
    });
  }

  /** 开始节点时验证 Run 仍可执行，并以 run/node/attempt 幂等。 */
  public async startStep(runId: string, command: StartRagRunStepCommand): Promise<RagRunStep> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const run = await this.lockRun(client, runId);
      if (run.status !== 'RUNNING')
        throw new ApplicationError('INVALID_STATE', 409, 'Run 不可执行节点');
      const existing = await client.query<StepRow>(
        'SELECT * FROM rag_run_steps WHERE run_id = $1 AND node_key = $2 AND attempt = $3 FOR UPDATE',
        [runId, command.nodeKey, command.attempt],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return mapStep(existing.rows[0]);
      }
      const result = await client.query<StepRow>(
        `INSERT INTO rag_run_steps (
           run_id, node_key, attempt, status, input_summary, trace_id, started_at
         ) VALUES ($1,$2,$3,'RUNNING',$4::jsonb,$5,now()) RETURNING *`,
        [
          runId,
          command.nodeKey,
          command.attempt,
          JSON.stringify(limitSummary(command.inputSummary)),
          command.traceId ?? null,
        ],
      );
      const step = requireRow(result.rows[0], 'Run Step 创建失败');
      await this.appendEvent(client, runId, 'run.step_started', {
        nodeKey: command.nodeKey,
        attempt: command.attempt,
      });
      await client.query('COMMIT');
      return mapStep(step);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 完成节点并计算数据库时间差；原始 Provider 错误不能进入摘要。 */
  public async finishStep(runId: string, command: FinishRagRunStepCommand): Promise<RagRunStep> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<StepRow>(
        'SELECT * FROM rag_run_steps WHERE run_id = $1 AND node_key = $2 AND attempt = $3 FOR UPDATE',
        [runId, command.nodeKey, command.attempt],
      );
      const row = requireRow(result.rows[0], 'Run Step 不存在');
      if (row.status === command.status) {
        await client.query('COMMIT');
        return mapStep(row);
      }
      assertRagRunStepTransition(row.status, command.status);
      const updated = await client.query<StepRow>(
        `UPDATE rag_run_steps SET status = $4, output_summary = $5::jsonb,
                error_code = $6, error_message = $7,
                duration_ms = GREATEST(0, floor(extract(epoch FROM (now() - started_at))*1000)::int),
                completed_at = now(), updated_at = now()
          WHERE run_id = $1 AND node_key = $2 AND attempt = $3 RETURNING *`,
        [
          runId,
          command.nodeKey,
          command.attempt,
          command.status,
          JSON.stringify(limitSummary(command.outputSummary)),
          command.errorCode ?? null,
          command.errorMessage?.slice(0, 500) ?? null,
        ],
      );
      const step = requireRow(updated.rows[0], 'Run Step 更新失败');
      await this.appendEvent(client, runId, 'run.step_completed', {
        nodeKey: command.nodeKey,
        attempt: command.attempt,
        status: command.status,
      });
      await client.query('COMMIT');
      return mapStep(step);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 答案消息、Run COMPLETED 和 answer.completed Outbox 在同一事务。 */
  public async completeRun(
    ownerUserId: string,
    runId: string,
    command: CompleteRagRunCommand,
  ): Promise<RagRun> {
    return this.withLockedRun(runId, ownerUserId, async (client, row) => {
      if (row.status === 'COMPLETED') {
        if (row.answer_sha256 === command.answer.sha256) return row;
        throw new ApplicationError('VERSION_CONFLICT', 409, 'Run 已有不同答案事实');
      }
      if (Number(row.optimistic_version) !== command.expectedVersion) throw versionConflict();
      assertRagRunTransition(row.status, 'COMPLETED');
      const message = await client.query<{ id: string }>(
        `INSERT INTO conversation_messages (
           conversation_id, run_id, role, status, content_storage, content_value,
           content_iv, content_auth_tag, content_sha256, citations_summary, retention_expires_at
         ) VALUES ($1,$2,'ASSISTANT','VISIBLE',$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
        [
          row.conversation_id,
          runId,
          command.answer.storage,
          command.answer.value,
          command.answer.iv ?? null,
          command.answer.authTag ?? null,
          command.answer.sha256,
          JSON.stringify(command.citationsSummary ?? null),
          command.retentionExpiresAt,
        ],
      );
      const assistantMessageId = requireRow(message.rows[0], '答案消息持久化失败').id;
      const updated = await client.query<RunRow>(
        `UPDATE rag_runs SET status = 'COMPLETED', assistant_message_id = $3,
                answer_sha256 = $4, public_message = '回答已完成', completed_at = now(),
                optimistic_version = optimistic_version + 1, updated_at = now()
          WHERE id = $1 AND optimistic_version = $2 RETURNING *`,
        [runId, command.expectedVersion, assistantMessageId, command.answer.sha256],
      );
      const next = requireVersionedRow(updated.rows[0]);
      await appendShortWindowMessage(client, row.conversation_id, assistantMessageId);
      await client.query(
        `UPDATE conversations SET last_message_at = now(), updated_at = now(),
                optimistic_version = optimistic_version + 1 WHERE id = $1`,
        [row.conversation_id],
      );
      await this.appendEvent(client, runId, 'answer.completed', {
        status: 'COMPLETED',
        assistantMessageId,
        answerSha256: command.answer.sha256,
      });
      return next;
    });
  }

  /** 将 RUNNING 失败转为终态并写稳定错误事件。 */
  public async failRun(
    ownerUserId: string,
    runId: string,
    expectedVersion: number,
    code: string,
  ): Promise<RagRun> {
    return this.finishRunWithoutAnswer(ownerUserId, runId, expectedVersion, 'FAILED', code);
  }

  /** 确认取消；只有 CANCELLING 可以进入 CANCELLED。 */
  public async finalizeCancellation(
    ownerUserId: string,
    runId: string,
    expectedVersion: number,
  ): Promise<RagRun> {
    return this.finishRunWithoutAnswer(
      ownerUserId,
      runId,
      expectedVersion,
      'CANCELLED',
      'RUN_CANCELLED',
    );
  }

  /** 反馈只允许关联当前用户的可见助手消息。 */
  public async saveFeedback(
    context: AccessContext,
    messageId: string,
    feedback: CreateMessageFeedbackRequest,
  ): Promise<MessageFeedback> {
    const result = await this.pool.query<{
      id: string;
      message_id: string;
      rating: 'HELPFUL' | 'NOT_HELPFUL';
      reason: string | null;
      tags: string[];
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO message_feedback (message_id, owner_user_id, rating, reason, tags)
       SELECT message.id, conversation.owner_user_id, $3, $4, $5
         FROM conversation_messages message
         JOIN conversations conversation ON conversation.id = message.conversation_id
        WHERE message.id = $1 AND conversation.owner_user_id = $2
          AND message.role = 'ASSISTANT' AND message.status = 'VISIBLE'
       ON CONFLICT (message_id, owner_user_id) DO UPDATE SET
         rating = EXCLUDED.rating, reason = EXCLUDED.reason,
         tags = EXCLUDED.tags, updated_at = now()
       RETURNING id, message_id, rating, reason, tags, created_at, updated_at`,
      [messageId, context.user.userId, feedback.rating, feedback.reason ?? null, feedback.tags],
    );
    const row = requireOwnedRow(result.rows[0], '消息不存在');
    return MessageFeedbackSchema.parse({
      id: row.id,
      messageId: row.message_id,
      rating: row.rating,
      ...(row.reason ? { reason: row.reason } : {}),
      tags: row.tags,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    });
  }

  /** 每个 Run 只领取最早的未发布事件，避免不同 Publisher 造成流内乱序。 */
  public async claimEventOutbox(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<readonly RagRunOutboxEvent[]> {
    const result = await this.pool.query<OutboxRow>(
      `WITH candidates AS (
         SELECT event.event_id FROM rag_run_event_outbox event
          WHERE event.published_at IS NULL AND event.available_at <= now()
            AND (event.locked_until IS NULL OR event.locked_until < now())
            AND NOT EXISTS (
              SELECT 1 FROM rag_run_event_outbox earlier
               WHERE earlier.run_id = event.run_id AND earlier.sequence < event.sequence
                 AND earlier.published_at IS NULL
            )
          ORDER BY event.occurred_at, event.sequence
          FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE rag_run_event_outbox event
          SET locked_by = $1, locked_until = now() + make_interval(secs => $3),
              attempts = attempts + 1
         FROM candidates WHERE event.event_id = candidates.event_id
       RETURNING event.*`,
      [workerId, limit, leaseSeconds],
    );
    return result.rows.map(mapOutbox);
  }

  /** 只有当前 lease owner 能确认发布。 */
  public async markEventPublished(eventId: string, workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE rag_run_event_outbox SET published_at = now(), locked_by = NULL,
              locked_until = NULL, last_error_code = NULL
        WHERE event_id = $1 AND locked_by = $2 AND published_at IS NULL`,
      [eventId, workerId],
    );
  }

  /** 发布失败释放租约并做有限退避。 */
  public async releaseEvent(
    eventId: string,
    workerId: string,
    errorCode: string,
    retryDelaySeconds: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE rag_run_event_outbox SET locked_by = NULL, locked_until = NULL,
              available_at = now() + make_interval(secs => $3), last_error_code = $4
        WHERE event_id = $1 AND locked_by = $2 AND published_at IS NULL`,
      [eventId, workerId, retryDelaySeconds, errorCode],
    );
  }

  /** 超时扫描逐行加锁并生成 run.expired Outbox。 */
  public async expireOverdueRuns(limit: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<RunRow>(
        `SELECT * FROM rag_runs WHERE deadline_at <= now()
          AND status IN ('ACCEPTED','RUNNING','CANCELLING')
          ORDER BY deadline_at FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      for (const row of result.rows) {
        assertRagRunTransition(row.status, 'EXPIRED');
        await client.query(
          `UPDATE rag_runs SET status = 'EXPIRED', failure_code = 'RUN_DEADLINE_EXCEEDED',
                  public_message = '执行已超时', completed_at = now(),
                  optimistic_version = optimistic_version + 1, updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `UPDATE rag_run_steps SET status = 'CANCELLED', error_code = 'RUN_DEADLINE_EXCEEDED',
                  error_message = 'Run Deadline 已到期', completed_at = now(), updated_at = now()
            WHERE run_id = $1 AND status IN ('QUEUED','RUNNING')`,
          [row.id],
        );
        await this.appendEvent(client, row.id, 'run.expired', { status: 'EXPIRED' });
      }
      await client.query('COMMIT');
      return result.rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** 到期只覆盖正文与引用，不删除 Hash、时间、状态和反馈审计。 */
  public async cleanupExpiredContent(limit: number): Promise<number> {
    const result = await this.pool.query<{ redacted_count: string | number }>(
      `WITH expired_messages AS (
         SELECT id FROM conversation_messages
          WHERE retention_expires_at <= now() AND status NOT IN ('REDACTED','DELETED')
          ORDER BY retention_expires_at FOR UPDATE SKIP LOCKED LIMIT $1
       ), redacted_messages AS (
       UPDATE conversation_messages message
          SET status = 'REDACTED', content_storage = 'REDACTED',
              content_value = '[内容已按保留策略清理]', content_iv = NULL,
              content_auth_tag = NULL, citations_summary = NULL, updated_at = now()
         FROM expired_messages WHERE message.id = expired_messages.id RETURNING 1
       ), expired_states AS (
         SELECT conversation_id FROM conversation_states
          WHERE summary_retention_expires_at <= now() AND summary_storage IS NOT NULL
          ORDER BY summary_retention_expires_at FOR UPDATE SKIP LOCKED LIMIT $1
       ), redacted_states AS (
         UPDATE conversation_states state
            SET summary_storage = NULL, summary_value = NULL, summary_iv = NULL,
                summary_auth_tag = NULL, summary_sha256 = NULL,
                summary_source_space_ids = ARRAY[]::uuid[], confirmed_entities = '[]'::jsonb,
                recent_citation_ids = ARRAY[]::uuid[], summary_retention_expires_at = NULL,
                optimistic_version = optimistic_version + 1, updated_at = now()
           FROM expired_states WHERE state.conversation_id = expired_states.conversation_id
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM redacted_messages) +
              (SELECT count(*) FROM redacted_states) AS redacted_count`,
      [limit],
    );
    return Number(result.rows[0]?.redacted_count ?? 0);
  }

  private async finishRunWithoutAnswer(
    ownerUserId: string,
    runId: string,
    expectedVersion: number,
    target: 'FAILED' | 'CANCELLED',
    code: string,
  ): Promise<RagRun> {
    return this.withLockedRun(runId, ownerUserId, async (client, row) => {
      if (row.status === target) return row;
      if (Number(row.optimistic_version) !== expectedVersion) throw versionConflict();
      assertRagRunTransition(row.status, target);
      const result = await client.query<RunRow>(
        `UPDATE rag_runs SET status = $3, failure_code = $4, public_message = $5,
                completed_at = now(), optimistic_version = optimistic_version + 1, updated_at = now()
          WHERE id = $1 AND optimistic_version = $2 RETURNING *`,
        [runId, expectedVersion, target, code, target === 'FAILED' ? '执行失败' : '已取消'],
      );
      const next = requireVersionedRow(result.rows[0]);
      await this.appendEvent(client, runId, target === 'FAILED' ? 'run.failed' : 'run.cancelled', {
        status: target,
        code,
      });
      return next;
    });
  }

  private async withLockedRun<T extends RunRow>(
    runId: string,
    ownerUserId: string,
    work: (client: PoolClient, row: RunRow) => Promise<T>,
  ): Promise<RagRun> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<RunRow>(
        'SELECT * FROM rag_runs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE',
        [runId, ownerUserId],
      );
      const row = requireOwnedRow(result.rows[0], 'Run 不存在');
      const next = await work(client, row);
      await client.query('COMMIT');
      return mapRun(next);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockRun(client: PoolClient, runId: string): Promise<RunRow> {
    const result = await client.query<RunRow>('SELECT * FROM rag_runs WHERE id = $1 FOR UPDATE', [
      runId,
    ]);
    return requireRow(result.rows[0], 'Run 不存在');
  }

  private async appendEvent(
    client: PoolClient,
    runId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const sequenceResult = await client.query<{ next_event_sequence: string | number }>(
      `UPDATE rag_runs SET next_event_sequence = next_event_sequence + 1
        WHERE id = $1 RETURNING next_event_sequence`,
      [runId],
    );
    const sequence = Number(
      requireRow(sequenceResult.rows[0], 'Run 事件序号生成失败').next_event_sequence,
    );
    await client.query(
      `INSERT INTO rag_run_event_outbox (run_id, sequence, event_type, payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [runId, sequence, eventType, JSON.stringify(limitSummary(payload))],
    );
  }
}

function mapConversation(row: ConversationRow): Conversation {
  return ConversationSchema.parse({
    id: row.id,
    title: row.title,
    status: row.status,
    optimisticVersion: Number(row.optimistic_version),
    lastMessageAt: row.last_message_at ? toIso(row.last_message_at) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function mapStoredMessage(row: MessageRow): StoredConversationMessage {
  const publicShape = ConversationMessageSchema.omit({
    content: true,
    contentStoredAs: true,
  }).parse({
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    role: row.role,
    status: row.status,
    contentSha256: row.content_sha256,
    citationsSummary: row.citations_summary,
    createdAt: toIso(row.created_at),
  });
  return {
    ...publicShape,
    protectedContent: {
      storage: row.content_storage,
      value: row.content_value,
      ...(row.content_iv ? { iv: row.content_iv } : {}),
      ...(row.content_auth_tag ? { authTag: row.content_auth_tag } : {}),
      sha256: row.content_sha256,
    },
  };
}

function mapStoredState(row: StateRow): StoredConversationState {
  const publicShape = ConversationStateSchema.omit({ summary: true }).parse({
    conversationId: row.conversation_id,
    optimisticVersion: Number(row.optimistic_version),
    confirmedEntities: row.confirmed_entities,
    recentCitationIds: row.recent_citation_ids,
    shortWindowMessageIds: row.short_window_message_ids,
    updatedAt: toIso(row.updated_at),
  });
  return {
    ...publicShape,
    summarySourceSpaceIds: row.summary_source_space_ids,
    ...(row.summary_storage && row.summary_value
      ? {
          protectedSummary: {
            storage: row.summary_storage,
            value: row.summary_value,
            ...(row.summary_iv ? { iv: row.summary_iv } : {}),
            ...(row.summary_auth_tag ? { authTag: row.summary_auth_tag } : {}),
            sha256: requireValue(row.summary_sha256),
          },
        }
      : {}),
  };
}

function mapRun(row: RunRow): RagRun {
  return RagRunSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    optimisticVersion: Number(row.optimistic_version),
    snapshot: row.snapshot,
    deadlineAt: toIso(row.deadline_at),
    eventExpiresAt: toIso(row.event_expires_at),
    cancelRequestedAt: row.cancel_requested_at ? toIso(row.cancel_requested_at) : null,
    failureCode: row.failure_code,
    publicMessage: row.public_message,
    createdAt: toIso(row.created_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    updatedAt: toIso(row.updated_at),
  });
}

function mapStep(row: StepRow): RagRunStep {
  return RagRunStepSchema.parse({
    id: row.id,
    runId: row.run_id,
    nodeKey: row.node_key,
    attempt: row.attempt,
    status: row.status,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    durationMs: row.duration_ms,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    traceId: row.trace_id,
    startedAt: row.started_at ? toIso(row.started_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
  });
}

function mapOutbox(row: OutboxRow): RagRunOutboxEvent {
  return {
    ...RagRunEventSchema.parse({
      eventId: row.event_id,
      runId: row.run_id,
      sequence: Number(row.sequence),
      schemaVersion: row.schema_version,
      eventType: row.event_type,
      payload: row.payload,
      occurredAt: toIso(row.occurred_at),
    }),
    attempts: row.attempts,
  };
}

function mapPublication(
  row: PublicationRow,
  kind: 'stable' | 'candidate',
): RunPublicationRoute['stable'] {
  if (kind === 'stable') {
    return {
      spaceId: row.space_id,
      manifestId: row.stable_manifest_id,
      manifestVersion: row.stable_manifest_version,
      embeddingProfileId: row.stable_embedding_profile_id,
      embeddingModelRevision: row.stable_embedding_model_revision,
      collectionName: row.stable_collection_name,
      authzPolicyVersion: Number(row.authz_policy_version),
    };
  }
  return {
    spaceId: row.space_id,
    manifestId: requireValue(row.candidate_manifest_id),
    manifestVersion: requireValue(row.candidate_manifest_version),
    embeddingProfileId: requireValue(row.candidate_embedding_profile_id),
    embeddingModelRevision: requireValue(row.candidate_embedding_model_revision),
    collectionName: requireValue(row.candidate_collection_name),
    authzPolicyVersion: Number(row.authz_policy_version),
  };
}

async function appendShortWindowMessage(
  client: PoolClient,
  conversationId: string,
  messageId: string,
): Promise<void> {
  await client.query(
    `UPDATE conversation_states SET
       short_window_message_ids = CASE
         WHEN cardinality(array_append(short_window_message_ids,$2::uuid)) > 100
         THEN (array_append(short_window_message_ids,$2::uuid))[cardinality(array_append(short_window_message_ids,$2::uuid))-99:]
         ELSE array_append(short_window_message_ids,$2::uuid)
       END,
       updated_at = now()
     WHERE conversation_id = $1`,
    [conversationId, messageId],
  );
}

function limitSummary(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 16_384) {
    throw new ApplicationError('SCHEMA_MISMATCH', 409, 'Run 摘要超过 16 KiB 上限');
  }
  return value;
}

function encodeConversationCursor(row: ConversationRow): string {
  return Buffer.from(JSON.stringify({ updatedAt: toIso(row.updated_at), id: row.id })).toString(
    'base64url',
  );
}

function decodeConversationCursor(value: string): { updatedAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['updatedAt'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['id'] === 'string'
    ) {
      return parsed as { updatedAt: string; id: string };
    }
  } catch {
    // 统一映射为稳定业务错误，不返回游标原文。
  }
  throw new ApplicationError('SCHEMA_MISMATCH', 409, '会话游标非法');
}

function toIso(value: Date): string {
  return value.toISOString();
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new ApplicationError('NOT_FOUND', 404, message);
  return row;
}

function requireOwnedRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new ApplicationError('NOT_FOUND', 404, message);
  return row;
}

function requireVersionedRow<T>(row: T | undefined): T {
  if (!row) throw versionConflict();
  return row;
}

function requireValue<T>(value: T | null): T {
  if (value === null) throw new ApplicationError('INVALID_STATE', 409, 'CANARY 快照不完整');
  return value;
}

function denied(): ApplicationError {
  return new ApplicationError('ACCESS_DENIED', 403, '无权执行该操作');
}

function versionConflict(): ApplicationError {
  return new ApplicationError('VERSION_CONFLICT', 409, 'Run 已被其他执行器更新');
}
