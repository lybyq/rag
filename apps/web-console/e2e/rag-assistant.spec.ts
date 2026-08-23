/**
 * 知识问答浏览器闭环：真实 Vue 页面 + Element Plus X Adapter，网络层提供版本化契约响应。
 *
 * 覆盖创建会话、提问、SSE 连续断线后 sequence 轮询恢复、答案发布、引用逐次鉴权和取消。
 * 测试数据为合成内容，不包含内网问题或证据。
 *
 * @requirement WEB-018
 * @requirement WEB-019
 * @requirement WEB-020
 * @requirement WEB-021
 * @requirement WEB-022
 * @requirement WEB-028
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const ids = {
  space: '018f6c1a-5412-7cc0-b242-92aa0f56f900',
  conversation: '018f6c1a-5412-7cc0-b242-92aa0f56f901',
  userMessage: '018f6c1a-5412-7cc0-b242-92aa0f56f902',
  assistantMessage: '018f6c1a-5412-7cc0-b242-92aa0f56f903',
  run: '018f6c1a-5412-7cc0-b242-92aa0f56f904',
  manifest: '018f6c1a-5412-7cc0-b242-92aa0f56f905',
  citation: '018f6c1a-5412-7cc0-b242-92aa0f56f906',
  event: '018f6c1a-5412-7cc0-b242-92aa0f56f907',
} as const;
const timestamp = '2026-08-23T08:00:00.000Z';

test('WEB-028 SSE 断线后轮询恢复答案，并在点击引用时重新鉴权', async ({ page }) => {
  const state = { answerReady: false, citationReads: 0, pollReads: 0, cancelled: false };
  await mockAssistantApi(page, state);

  await page.goto('/assistant');
  await expect(page.getByRole('button', { name: '制度摘要' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '制度摘要' }).click();

  await expect(page.getByText('SSE 断开 · 轮询恢复中')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole('button', { name: '答案已通过校验并发布' })).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.getByText('企业审批必须由直属负责人复核')).toBeVisible();

  await page.getByRole('button', { name: '证据' }).click();
  await expect(page.getByRole('heading', { name: '企业审批制度' })).toBeVisible();
  await expect(page.getByText('审批申请应由直属负责人完成复核。')).toBeVisible();
  expect(state.citationReads).toBe(1);
  expect(state.pollReads).toBeGreaterThan(0);
});

test('WEB-028 用户取消运行后页面显示独立的安全取消状态', async ({ page }) => {
  const state = { answerReady: false, citationReads: 0, pollReads: 0, cancelled: false };
  await mockAssistantApi(page, state);

  await page.goto('/assistant');
  await expect(page.getByRole('button', { name: '流程追问' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '流程追问' }).click();
  await page.getByRole('button', { name: '取消运行' }).click();

  await expect(
    page.getByRole('button', { name: '取消请求已提交，等待当前节点安全停止' }),
  ).toBeVisible();
  expect(state.cancelled).toBe(true);
});

interface MockState {
  answerReady: boolean;
  citationReads: number;
  pollReads: number;
  cancelled: boolean;
}

/** 在浏览器网络边界返回与共享 Zod Schema 一致的确定性响应。 */
async function mockAssistantApi(page: Page, state: MockState): Promise<void> {
  await page.route('**/api/v1/run-streams/**', (route) =>
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'synthetic disconnect' }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/v1/auth/dev/presets') {
      return json(
        route,
        envelope({
          selectionHeader: 'x-rag-mock-user',
          defaultPresetId: 'admin',
          items: [
            {
              presetId: 'admin',
              label: '系统管理员',
              userId: 'e2e-admin',
              roles: ['SYSTEM_ADMIN'],
            },
          ],
        }),
      );
    }
    if (path === '/api/v1/auth/me') {
      return json(
        route,
        envelope({
          user: {
            userId: 'e2e-admin',
            roles: ['SYSTEM_ADMIN'],
            authzVersion: 1,
            resolvedAt: timestamp,
          },
          authMode: 'mock',
          appEnv: 'development',
        }),
      );
    }
    if (path === '/api/v1/spaces') return json(route, envelope({ items: [space()], total: 1 }));
    if (path === '/api/v1/conversations' && request.method() === 'GET') {
      return json(route, envelope({ items: [], nextCursor: null }));
    }
    if (path === '/api/v1/conversations' && request.method() === 'POST') {
      return json(route, envelope(conversation()), 201);
    }
    if (path === `/api/v1/conversations/${ids.conversation}/messages`) {
      return json(
        route,
        envelope({ items: messages(state.answerReady), state: conversationState() }),
      );
    }
    if (path === `/api/v1/conversations/${ids.conversation}/runs`) {
      return json(
        route,
        envelope({
          run: ragRun('ACCEPTED'),
          eventsUrl: `/api/v1/runs/${ids.run}/events`,
          ticketUrl: `/api/v1/runs/${ids.run}/stream-ticket`,
          expiresAt: '2026-08-23T08:05:00.000Z',
          replayed: false,
        }),
        202,
      );
    }
    if (path === `/api/v1/runs/${ids.run}/stream-ticket`) {
      return json(
        route,
        envelope({
          ticket: 'a'.repeat(48),
          streamUrl: `/api/v1/run-streams/${ids.run}`,
          expiresAt: '2026-08-23T08:01:00.000Z',
        }),
        201,
      );
    }
    if (path === `/api/v1/runs/${ids.run}/events/poll`) {
      state.pollReads += 1;
      // 留出可观察窗口，证明页面确实进入了轮询降级，而不是直接跳到完成态。
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      state.answerReady = true;
      return json(
        route,
        envelope({
          items: [
            {
              eventId: ids.event,
              runId: ids.run,
              sequence: 1,
              schemaVersion: 1,
              eventType: 'answer.completed',
              payload: { status: 'COMPLETED' },
              occurredAt: timestamp,
            },
          ],
          nextSequence: 1,
          streamExpired: false,
          run: ragRun('COMPLETED'),
        }),
      );
    }
    if (path === `/api/v1/runs/${ids.run}/cancel`) {
      state.cancelled = true;
      return json(route, envelope(ragRun('CANCELLED')), 201);
    }
    if (path === `/api/v1/citations/${ids.citation}`) {
      state.citationReads += 1;
      return json(
        route,
        envelope({
          citationId: ids.citation,
          title: '企业审批制度',
          headingPath: ['第三章', '审批复核'],
          excerpt: '审批申请应由直属负责人完成复核。',
          sourceLocations: [{ page: 3 }],
          publishedAt: timestamp,
          effectiveFrom: timestamp,
          effectiveTo: null,
        }),
      );
    }
    return json(
      route,
      {
        requestId: 'e2e',
        code: 'NOT_FOUND',
        message: `未模拟 ${path}`,
        retryable: false,
      },
      404,
    );
  });
}

function envelope(data: unknown): Record<string, unknown> {
  return { requestId: 'e2e-request', traceId: 'e2e-trace', data };
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function space(): Record<string, unknown> {
  return {
    id: ids.space,
    code: 'enterprise-policy',
    name: '企业制度库',
    description: '合成验收空间',
    ownerUserId: 'e2e-admin',
    status: 'ACTIVE',
    version: 1,
    policyVersion: 1,
    documentCount: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    effectivePermissions: ['READ', 'WRITE', 'REVIEW', 'ADMIN'],
  };
}

function conversation(): Record<string, unknown> {
  return {
    id: ids.conversation,
    title: '企业审批制度',
    status: 'ACTIVE',
    optimisticVersion: 1,
    lastMessageAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function messages(answerReady: boolean): readonly Record<string, unknown>[] {
  const user = {
    id: ids.userMessage,
    conversationId: ids.conversation,
    runId: ids.run,
    role: 'USER',
    status: 'VISIBLE',
    content: '请概括当前知识空间中最重要的制度及其生效范围',
    contentStoredAs: 'PLAIN',
    contentSha256: 'a'.repeat(64),
    citationsSummary: null,
    createdAt: timestamp,
  };
  if (!answerReady) return [user];
  return [
    user,
    {
      id: ids.assistantMessage,
      conversationId: ids.conversation,
      runId: ids.run,
      role: 'ASSISTANT',
      status: 'VISIBLE',
      content: `企业审批必须由直属负责人复核 [${ids.citation}]`,
      contentStoredAs: 'PLAIN',
      contentSha256: 'b'.repeat(64),
      citationsSummary: { count: 1 },
      createdAt: timestamp,
    },
  ];
}

function conversationState(): Record<string, unknown> {
  return {
    conversationId: ids.conversation,
    optimisticVersion: 1,
    summary: null,
    confirmedEntities: [],
    recentCitationIds: [],
    shortWindowMessageIds: [],
    updatedAt: timestamp,
  };
}

function ragRun(status: 'ACCEPTED' | 'COMPLETED' | 'CANCELLED'): Record<string, unknown> {
  const terminal = status !== 'ACCEPTED';
  return {
    id: ids.run,
    conversationId: ids.conversation,
    userMessageId: ids.userMessage,
    assistantMessageId: terminal && status === 'COMPLETED' ? ids.assistantMessage : null,
    status,
    optimisticVersion: terminal ? 2 : 1,
    snapshot: {
      flowVersion: 'answer-generation-v1',
      policyVersion: 'strict-evidence-v1',
      promptProfileId: 'prompt-v1',
      embeddingProfileId: 'embedding-v1',
      embeddingRevision: 'fixture-v1',
      rerankerProfileId: 'reranker-v1',
      rerankerRevision: 'fixture-v1',
      llmProfileId: 'llm-v1',
      llmRevision: 'fixture-v1',
      validatorProfileId: 'validator-v1',
      manifests: [
        {
          spaceId: ids.space,
          manifestId: ids.manifest,
          manifestVersion: 1,
          embeddingProfileId: 'embedding-v1',
          embeddingModelRevision: 'fixture-v1',
          collectionName: 'rag_e2e',
          authzPolicyVersion: 1,
        },
      ],
      authzVersion: 1,
      rolesSha256: 'c'.repeat(64),
      retrieval: {
        profileId: 'balanced-v1',
        initialTopK: 40,
        finalTopK: 8,
        rrfK: 60,
        denseWeight: 1,
        sparseWeight: 1,
        maxPerDocument: 3,
        maxPerSection: 2,
        minimumResults: 2,
        maxRounds: 2,
      },
    },
    deadlineAt: '2026-08-23T08:05:00.000Z',
    eventExpiresAt: '2026-08-24T08:00:00.000Z',
    cancelRequestedAt: status === 'CANCELLED' ? timestamp : null,
    failureCode: null,
    publicMessage:
      status === 'COMPLETED' ? '答案已发布' : status === 'CANCELLED' ? '运行已取消' : '已接受',
    createdAt: timestamp,
    startedAt: terminal ? timestamp : null,
    completedAt: terminal ? timestamp : null,
    updatedAt: timestamp,
  };
}
