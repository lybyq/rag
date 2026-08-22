/**
 * M06 真实 PostgreSQL + Redis 集成门禁。
 *
 * 验证并发幂等、冻结发布快照、Run/Step 状态机、答案与完成事件事务顺序、精确 sequence、
 * 一次性 Ticket、跨层取消、历史消息重新鉴权、Deadline 和正文保留期清理。
 * 测试使用合成内容与本地 AES 密钥，不依赖公网 LLM、Milvus 或内网模型。
 *
 * @requirement RUN-001
 * @requirement RUN-002
 * @requirement RUN-004
 * @requirement RUN-005
 * @requirement RUN-006
 * @requirement RUN-007
 * @requirement RUN-008
 * @requirement RUN-009
 * @requirement RUN-010
 * @requirement RUN-011
 * @requirement RUN-012
 * @requirement RUN-014
 */
import {
  RagRunEventPublisherService,
  RagRunLifecycleService,
  RagRunMaintenanceService,
  RagRunService,
  type AccessContext,
  type AuthorizationService,
} from '@rag/application';
import { loadAppConfig } from '@rag/config';
import { PostgresRagRunRepository } from '@rag/persistence-pg';
import { RedisRagRunEventStreamAdapter } from '@rag/persistence-redis';
import { createTestUserContext } from '@rag/testing';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AesGcmSensitiveTextProtector } from '../../apps/rag-query-service/src/m06/aes-gcm-sensitive-text.protector';

const describeWithInfra = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeWithInfra('[RUN-001..014] M06 conversation and run', () => {
  const config = loadAppConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 8 });
  const repository = new PostgresRagRunRepository(pool);
  const redis = new Redis(config.redisCacheUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
  const stream = new RedisRagRunEventStreamAdapter(config);
  const protector = new AesGcmSensitiveTextProtector({
    ...config.run,
    contentStorage: 'AES_256_GCM',
    contentEncryptionKey: Buffer.from('m06-integration-key-32-bytes!!!!').toString('base64'),
  });
  const suffix = randomUUID().slice(0, 8);
  const spaceId = randomUUID();
  const manifestId = randomUUID();
  const profileId = `m06-profile-${suffix}`;
  const owner: AccessContext = {
    user: createTestUserContext(`m06-owner-${suffix}`, ['KNOWLEDGE_READER']),
    requestId: `m06-request-${suffix}`,
    traceId: `m06-trace-${suffix}`,
  };
  const outsider: AccessContext = {
    user: createTestUserContext(`m06-outsider-${suffix}`, ['KNOWLEDGE_READER']),
    requestId: `m06-outsider-request-${suffix}`,
  };
  let allowHistoricalSpace = true;
  const authorization = {
    restrictRequestedSpaces: jest.fn(
      async (_context: AccessContext, requested: readonly string[]): Promise<readonly string[]> =>
        allowHistoricalSpace ? requested : [],
    ),
  } as unknown as AuthorizationService;
  const service = new RagRunService(repository, authorization, protector, stream, stream, {
    flowVersion: 'm06-flow-v1',
    policyVersion: 'm06-policy-v1',
    promptProfileId: 'm06-prompt-v1',
    validatorProfileId: 'm06-validator-v1',
    embeddingProfileId: profileId,
    embeddingRevision: 'embedding-r1',
    rerankerProfileId: 'm06-reranker',
    rerankerRevision: 'reranker-r1',
    llmProfileId: 'm06-llm',
    llmRevision: 'llm-r1',
    deadlineSeconds: 600,
    eventRetentionSeconds: 600,
    contentRetentionDays: 30,
    streamTicketTtlSeconds: 60,
    shortWindowMessages: 20,
  });
  const lifecycle = new RagRunLifecycleService(repository, protector, stream, {
    contentRetentionDays: 30,
  });
  const publisher = new RagRunEventPublisherService(repository, stream, {
    batchSize: 100,
    leaseSeconds: 30,
    retentionSeconds: 600,
    maxLength: 1_000,
  });
  const maintenance = new RagRunMaintenanceService(repository);
  const createdRunIds: string[] = [];
  let conversationId = '';

  beforeAll(async () => {
    await stream.onModuleInit();
    await seedPublishedSpace(pool, {
      spaceId,
      manifestId,
      profileId,
      ownerUserId: owner.user.userId,
      suffix,
    });
    conversationId = (await service.createConversation(owner, { title: 'M06 集成会话' })).id;
  });

  afterAll(async () => {
    allowHistoricalSpace = true;
    await cleanupRedis(redis, createdRunIds);
    await stream.onModuleDestroy();
    redis.disconnect(false);
    await cleanupM06(pool, conversationId, spaceId, profileId);
    await pool.end();
  });

  test('[RUN-002][RUN-004] 并发重放只生成一份 Run/消息且冻结发布与模型版本', async () => {
    const key = `m06-concurrent-${suffix}`;
    const request = { question: '并发幂等问题', requestedSpaceIds: [spaceId] };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.createRun(owner, conversationId, key, request)),
    );
    const run = results[0]!.run;
    createdRunIds.push(run.id);

    expect(new Set(results.map((result) => result.run.id))).toEqual(new Set([run.id]));
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(run.snapshot.manifests).toEqual([
      expect.objectContaining({ spaceId, manifestId, manifestVersion: 1 }),
    ]);
    expect(run.snapshot).toEqual(
      expect.objectContaining({
        flowVersion: 'm06-flow-v1',
        embeddingProfileId: profileId,
        llmRevision: 'llm-r1',
        authzVersion: owner.user.authzVersion,
      }),
    );
    const facts = await pool.query<{ runs: number; messages: number }>(
      `SELECT
         (SELECT count(*)::int FROM rag_runs WHERE owner_user_id = $1 AND idempotency_key = $2) AS runs,
         (SELECT count(*)::int FROM conversation_messages WHERE run_id = $3) AS messages`,
      [owner.user.userId, key, run.id],
    );
    expect(facts.rows[0]).toEqual({ runs: 1, messages: 1 });
    await expect(
      service.createRun(owner, conversationId, key, {
        ...request,
        question: '同键但不同请求',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT', httpStatus: 409 });
  });

  test('[RUN-005..012] 答案事实先于顺序完成事件，Ticket 只能兑换一次且撤权后历史脱敏', async () => {
    const accepted = await service.createRun(owner, conversationId, `m06-complete-${suffix}`, {
      question: '制度的报销上限是什么？',
      requestedSpaceIds: [spaceId],
    });
    const runId = accepted.run.id;
    createdRunIds.push(runId);
    const started = await lifecycle.start(owner.user.userId, runId, accepted.run.optimisticVersion);
    expect(started.signal.aborted).toBe(false);
    await lifecycle.startStep(runId, {
      nodeKey: 'retrieve',
      attempt: 1,
      inputSummary: { queryChars: 12, spaceCount: 1 },
      traceId: owner.traceId,
    });
    await lifecycle.finishStep(runId, {
      nodeKey: 'retrieve',
      attempt: 1,
      status: 'SUCCEEDED',
      outputSummary: { candidateCount: 3, topK: 3 },
    });
    const completed = await lifecycle.complete(
      owner.user.userId,
      runId,
      started.run.optimisticVersion,
      '单笔报销上限为 5000 元。',
      { spaceIds: [spaceId], citationIds: [randomUUID()] },
    );
    expect(completed.status).toBe('COMPLETED');

    const atomicFacts = await pool.query<{
      assistant_message_id: string;
      answer_event_message_id: string;
      content_value: string;
    }>(
      `SELECT run.assistant_message_id,
              event.payload->>'assistantMessageId' AS answer_event_message_id,
              message.content_value
         FROM rag_runs run
         JOIN conversation_messages message ON message.id = run.assistant_message_id
         JOIN rag_run_event_outbox event ON event.run_id = run.id
              AND event.event_type = 'answer.completed'
        WHERE run.id = $1`,
      [runId],
    );
    expect(atomicFacts.rows[0]?.assistant_message_id).toBe(
      atomicFacts.rows[0]?.answer_event_message_id,
    );
    expect(atomicFacts.rows[0]?.content_value).not.toContain('5000');

    await publishUntilEmpty(publisher);
    const page = await service.listEvents(owner, runId, 0, 100);
    expect(page.items.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(page.items.map((event) => event.eventType)).toEqual([
      'run.accepted',
      'run.started',
      'run.step_started',
      'run.step_completed',
      'answer.completed',
    ]);
    await expect(stream.read(runId, 3, 100)).resolves.toMatchObject({
      items: [{ sequence: 4 }, { sequence: 5 }],
      nextSequence: 5,
      exists: true,
    });
    // PG Outbox 在 Redis 确认后、标记 published 前崩溃会重投同一事件，Lua 必须幂等忽略。
    await stream.append(page.items.at(-1)!, 600, 1_000);
    await expect(stream.read(runId, 0, 100)).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ sequence: 5 })]),
      nextSequence: 5,
    });
    // 人为跳过 6 能证明 Redis 不会为了“继续跑”而接受乱序事实。
    await expect(
      stream.append(
        {
          eventId: randomUUID(),
          runId,
          sequence: 7,
          schemaVersion: 1,
          eventType: 'run.synthetic_gap',
          payload: {},
          occurredAt: new Date().toISOString(),
        },
        600,
        1_000,
      ),
    ).rejects.toThrow(/RUN_EVENT_SEQUENCE_GAP/);

    const issued = await service.issueStreamTicket(owner, runId);
    await expect(service.redeemStreamTicket(issued.ticket, runId)).resolves.toMatchObject({
      userId: owner.user.userId,
      run: { id: runId },
    });
    await expect(service.redeemStreamTicket(issued.ticket, runId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const visible = await service.listMessages(owner, conversationId);
    const answer = visible.items.find(
      (message) => message.runId === runId && message.role === 'ASSISTANT',
    );
    expect(answer?.content).toBe('单笔报销上限为 5000 元。');
    const citationId = randomUUID();
    await expect(
      lifecycle.saveConversationState(
        owner.user.userId,
        conversationId,
        visible.state.optimisticVersion,
        {
          summary: '用户正在询问报销制度。',
          summarySourceSpaceIds: [spaceId],
          confirmedEntities: ['报销制度'],
          recentCitationIds: [citationId],
        },
      ),
    ).resolves.toMatchObject({
      optimisticVersion: 1,
      summary: '用户正在询问报销制度。',
      confirmedEntities: ['报销制度'],
      recentCitationIds: [citationId],
    });
    await expect(
      service.saveFeedback(owner, completed.assistantMessageId!, {
        rating: 'HELPFUL',
        reason: '引用清晰',
        tags: ['准确'],
      }),
    ).resolves.toMatchObject({ messageId: completed.assistantMessageId, rating: 'HELPFUL' });

    allowHistoricalSpace = false;
    const revoked = await service.listMessages(owner, conversationId);
    const revokedAnswer = revoked.items.find(
      (message) => message.runId === runId && message.role === 'ASSISTANT',
    );
    expect(revokedAnswer).toMatchObject({ status: 'REDACTED', content: null });
    expect(revoked.state).toMatchObject({
      summary: null,
      confirmedEntities: [],
      recentCitationIds: [],
    });
    allowHistoricalSpace = true;

    await expect(
      lifecycle.complete(owner.user.userId, runId, completed.optimisticVersion, '不同的晚到答案'),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  test('[RUN-010] 取消先中止 Signal，再由执行器确认 CANCELLED，其他用户始终得到 404', async () => {
    const accepted = await service.createRun(owner, conversationId, `m06-cancel-${suffix}`, {
      question: '请取消这个问题',
      requestedSpaceIds: [spaceId],
    });
    const runId = accepted.run.id;
    createdRunIds.push(runId);
    const signal = stream.signal(runId);
    const cancelling = await service.cancelRun(owner, runId, '用户离开页面');

    expect(cancelling.status).toBe('CANCELLING');
    expect(signal.aborted).toBe(true);
    const cancelled = await lifecycle.finalizeCancellation(
      owner.user.userId,
      runId,
      cancelling.optimisticVersion,
    );
    expect(cancelled.status).toBe('CANCELLED');
    await expect(service.getRun(outsider, runId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
  });

  test('[RUN-005][RUN-014] Deadline 转 EXPIRED，正文到期只脱敏而保留审计 Hash', async () => {
    const accepted = await service.createRun(owner, conversationId, `m06-expire-${suffix}`, {
      question: '即将到期的合成问题',
      requestedSpaceIds: [spaceId],
    });
    const runId = accepted.run.id;
    createdRunIds.push(runId);
    // 极早时间 + limit=1 让维护器确定只领取本测试事实，避免触碰共享开发库中的其他到期数据。
    await pool.query(`UPDATE rag_runs SET deadline_at = '1900-01-01T00:00:00Z' WHERE id = $1`, [
      runId,
    ]);
    await pool.query(
      `UPDATE conversation_messages SET retention_expires_at = '1900-01-01T00:00:00Z'
        WHERE run_id = $1`,
      [runId],
    );
    await pool.query(
      `UPDATE conversation_states SET summary_retention_expires_at = '1900-01-01T00:00:00Z'
        WHERE conversation_id = $1`,
      [conversationId],
    );

    await expect(maintenance.runOnce(1)).resolves.toEqual({
      expiredRuns: 1,
      redactedContents: 2,
    });
    const expired = await service.getRun(owner, runId);
    expect(expired.status).toBe('EXPIRED');
    const message = await pool.query<{
      status: string;
      content_storage: string;
      content_sha256: string;
    }>(
      `SELECT status, content_storage, content_sha256
         FROM conversation_messages WHERE run_id = $1 AND role = 'USER'`,
      [runId],
    );
    expect(message.rows[0]).toMatchObject({
      status: 'REDACTED',
      content_storage: 'REDACTED',
      content_sha256: createHash('sha256').update('即将到期的合成问题').digest('hex'),
    });
    await expect(service.listMessages(owner, conversationId)).resolves.toMatchObject({
      state: { summary: null, confirmedEntities: [], recentCitationIds: [] },
    });
  });
});

interface SeedPublishedSpaceInput {
  readonly spaceId: string;
  readonly manifestId: string;
  readonly profileId: string;
  readonly ownerUserId: string;
  readonly suffix: string;
}

/** 创建 M06 需要的最小 ACTIVE M05 发布事实，不伪造任何检索结果。 */
async function seedPublishedSpace(pool: Pool, input: SeedPublishedSpaceInput): Promise<void> {
  const compatibility = createHash('sha256').update(`m06-${input.suffix}`).digest('hex');
  const collection = `m06_collection_${input.suffix}`;
  const alias = `m06_alias_${input.suffix}`;
  await pool.query(
    `INSERT INTO knowledge_spaces (id, code, name, owner_user_id)
     VALUES ($1,$2,'M06 集成空间',$3)`,
    [input.spaceId, `m06-it-${input.suffix}`, input.ownerUserId],
  );
  await pool.query(
    `INSERT INTO knowledge_space_policies (space_id, version, grants, changed_by, change_reason)
     VALUES ($1,1,'[]'::jsonb,$2,'M06 集成测试基线')`,
    [input.spaceId, input.ownerUserId],
  );
  await pool.query(
    `INSERT INTO embedding_collection_registry (
       embedding_profile_id, compatibility_sha256, provider_profile, model_id,
       model_revision, tokenizer_revision, dense_dimension, normalize_dense,
       document_template_version, query_template_version, collection_name, alias_name
     ) VALUES ($1,$2,'external-ci','m06-fixture','embedding-r1','tokenizer-r1',2,true,
               'document-v1','query-v1',$3,$4)`,
    [input.profileId, compatibility, collection, alias],
  );
  await pool.query(
    `INSERT INTO space_manifests (
       id, space_id, version, status, provider_profile, embedding_profile_id,
       embedding_model_id, embedding_model_revision, tokenizer_revision,
       dense_dimension, normalize_dense, collection_name, activated_at
     ) VALUES ($1,$2,1,'ACTIVE','external-ci',$3,'m06-fixture','embedding-r1',
               'tokenizer-r1',2,true,$4,now())`,
    [input.manifestId, input.spaceId, input.profileId, collection],
  );
  await pool.query(
    `INSERT INTO space_manifest_heads (space_id, active_manifest_id, active_manifest_version)
     VALUES ($1,$2,1)`,
    [input.spaceId, input.manifestId],
  );
}

/** Outbox 每个 Run 一次只领取最早事件，因此循环到空才能证明严格顺序发布。 */
async function publishUntilEmpty(publisher: RagRunEventPublisherService): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    const result = await publisher.publishBatch(`m06-it-publisher-${round}`);
    expect(result.failed).toBe(0);
    if (result.claimed === 0) return;
  }
  throw new Error('M06 Outbox 在限定轮次内未排空');
}

/** 仅删除本测试生成的精确 Redis Key。 */
async function cleanupRedis(redis: Redis, runIds: readonly string[]): Promise<void> {
  if (redis.status === 'wait') await redis.connect();
  const keys = runIds.flatMap((runId) => [
    `rag:run:${runId}:events`,
    `rag:run:${runId}:last-sequence`,
  ]);
  if (keys.length > 0) await redis.del(...keys);
}

/** 按外键逆序清理本测试会话和发布快照，不触碰开发者已有数据。 */
async function cleanupM06(
  pool: Pool,
  conversationId: string,
  spaceId: string,
  profileId: string,
): Promise<void> {
  if (conversationId) {
    await pool.query(
      `DELETE FROM message_feedback WHERE message_id IN (
         SELECT id FROM conversation_messages WHERE conversation_id = $1
       )`,
      [conversationId],
    );
    await pool.query(
      `DELETE FROM rag_run_event_outbox WHERE run_id IN (
         SELECT id FROM rag_runs WHERE conversation_id = $1
       )`,
      [conversationId],
    );
    await pool.query(
      `DELETE FROM rag_run_steps WHERE run_id IN (
         SELECT id FROM rag_runs WHERE conversation_id = $1
       )`,
      [conversationId],
    );
    await pool.query('DELETE FROM rag_runs WHERE conversation_id = $1', [conversationId]);
    await pool.query('DELETE FROM conversation_messages WHERE conversation_id = $1', [
      conversationId,
    ]);
    await pool.query('DELETE FROM conversation_states WHERE conversation_id = $1', [
      conversationId,
    ]);
    await pool.query('DELETE FROM conversations WHERE id = $1', [conversationId]);
  }
  await pool.query('DELETE FROM space_manifest_heads WHERE space_id = $1', [spaceId]);
  await pool.query('DELETE FROM space_manifests WHERE space_id = $1', [spaceId]);
  await pool.query('DELETE FROM embedding_collection_registry WHERE embedding_profile_id = $1', [
    profileId,
  ]);
  await pool.query('DELETE FROM knowledge_space_policies WHERE space_id = $1', [spaceId]);
  await pool.query('DELETE FROM knowledge_spaces WHERE id = $1', [spaceId]);
}
