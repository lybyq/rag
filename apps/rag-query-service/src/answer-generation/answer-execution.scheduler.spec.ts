/**
 * 答案执行槽位调度回归测试。
 *
 * @requirement ANS-003
 * @requirement OPT-015
 */
import type { RagRunRepository } from '@rag/application';
import { loadAppConfig } from '@rag/config';
import type { ClaimedRagRunExecution } from '@rag/application';
import type { RagRun } from '@rag/contracts';
import type { AnswerGenerationExecutionService } from '@rag/rag-graph';
import { createHash } from 'node:crypto';
import { AnswerExecutionScheduler } from './answer-execution.scheduler';

describe('[OPT-015] AnswerExecutionScheduler fixed slots', () => {
  it('一个慢 Run 不阻塞已释放槽位领取并执行下一条 Run', async () => {
    const slow = deferred<void>();
    const next = deferred<void>();
    const firstClaims = [claimed('slow'), claimed('fast')];
    const claimAcceptedRuns = jest
      .fn()
      .mockResolvedValueOnce(firstClaims)
      .mockResolvedValueOnce([claimed('next')])
      .mockResolvedValue([]);
    const repository = {
      claimAcceptedRuns,
      failRun: jest.fn(),
    } as unknown as RagRunRepository;
    const execute = jest.fn(async (_context, item) => {
      if (item.run.id === runId('slow')) return slow.promise;
      if (item.run.id === runId('next')) return next.promise;
      return undefined;
    });
    const scheduler = new AnswerExecutionScheduler(
      repository,
      { execute } as unknown as AnswerGenerationExecutionService,
      { getCurrentVersion: jest.fn(async () => 1) },
      loadAppConfig({ ANSWER_EXECUTION_BATCH_SIZE: '2' }),
    );

    await tick(scheduler);
    await eventually(() => expect(execute).toHaveBeenCalledTimes(3));

    expect(claimAcceptedRuns).toHaveBeenNthCalledWith(1, expect.any(String), 2, 60);
    expect(claimAcceptedRuns).toHaveBeenNthCalledWith(2, expect.any(String), 1, 60);
    expect(execute.mock.calls.map((call) => call[1].run.id)).toEqual([
      runId('slow'),
      runId('fast'),
      runId('next'),
    ]);

    slow.resolve();
    next.resolve();
    await scheduler.onModuleDestroy();
  });

  it('关闭时等待已领取任务结束，并且不再领取新 Run', async () => {
    const running = deferred<void>();
    const repository = {
      claimAcceptedRuns: jest.fn().mockResolvedValueOnce([claimed('running')]),
      failRun: jest.fn(),
    } as unknown as RagRunRepository;
    const scheduler = new AnswerExecutionScheduler(
      repository,
      {
        execute: jest.fn(async () => running.promise),
      } as unknown as AnswerGenerationExecutionService,
      { getCurrentVersion: jest.fn(async () => 1) },
      loadAppConfig({ ANSWER_EXECUTION_BATCH_SIZE: '1' }),
    );
    await tick(scheduler);

    let closed = false;
    const closing = scheduler.onModuleDestroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    running.resolve();
    await closing;
    await tick(scheduler);
    expect(repository.claimAcceptedRuns).toHaveBeenCalledTimes(1);
  });
});

function tick(scheduler: AnswerExecutionScheduler): Promise<void> {
  return (
    scheduler as unknown as {
      tick(): Promise<void>;
    }
  ).tick();
}

function claimed(seed: string): ClaimedRagRunExecution {
  return {
    run: run(seed),
    ownerUserId: 'scheduler-user',
    roles: ['KNOWLEDGE_READER'] as const,
    authzVersion: 1,
  };
}

function run(seed: string): RagRun {
  const now = new Date().toISOString();
  return {
    id: runId(seed),
    conversationId: runId(`${seed}-conversation`),
    userMessageId: runId(`${seed}-message`),
    assistantMessageId: null,
    status: 'ACCEPTED',
    optimisticVersion: 0,
    snapshot: {
      flowVersion: 'flow-v1',
      policyVersion: 'policy-v1',
      promptProfileId: 'prompt-v1',
      embeddingProfileId: 'embedding-v1',
      embeddingRevision: 'r1',
      rerankerProfileId: 'reranker-v1',
      rerankerRevision: 'r1',
      llmProfileId: 'llm-v1',
      llmRevision: 'r1',
      validatorProfileId: 'validator-v1',
      manifests: [],
      authzVersion: 1,
      rolesSha256: createHash('sha256').update('KNOWLEDGE_READER').digest('hex'),
      retrieval: {
        profileId: 'retrieval-v1',
        initialTopK: 40,
        candidatePoolTopK: 40,
        finalTopK: 12,
        maxConcurrency: 8,
        rrfK: 60,
        denseWeight: 1,
        sparseWeight: 0,
        maxPerDocument: 3,
        maxPerSection: 2,
        minimumResults: 3,
        maxRounds: 2,
      },
    },
    deadlineAt: now,
    eventExpiresAt: now,
    cancelRequestedAt: null,
    failureCode: null,
    publicMessage: '已接收',
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
  };
}

function runId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
