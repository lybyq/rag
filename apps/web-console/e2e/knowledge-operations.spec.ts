/**
 * 知识运营浏览器闭环：上传到发布状态、审核双栏和授权检索调试。
 * 网络层只提供合成且满足共享 Zod Schema 的响应，真实依赖链由 integration 门禁负责。
 *
 * @requirement WEB-010
 * @requirement WEB-011
 * @requirement WEB-016
 * @requirement WEB-017
 * @requirement WEB-028
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const id = {
  space: '028f6c1a-5412-7cc0-b242-92aa0f56f900',
  upload: '028f6c1a-5412-7cc0-b242-92aa0f56f901',
  file: '028f6c1a-5412-7cc0-b242-92aa0f56f902',
  document: '028f6c1a-5412-7cc0-b242-92aa0f56f903',
  version: '028f6c1a-5412-7cc0-b242-92aa0f56f904',
  documentFile: '028f6c1a-5412-7cc0-b242-92aa0f56f905',
  run: '028f6c1a-5412-7cc0-b242-92aa0f56f906',
  vector: 'd'.repeat(64),
  chunk: 'chunk-e2e-1',
} as const;
const now = '2026-08-23T08:00:00.000Z';

test('WEB-028 文件由浏览器直传，并观察到后端 PUBLISH 成功事实', async ({ page }) => {
  const state = { uploadComplete: false, clientFileId: '' };
  await commonRoutes(page);
  await page.route('**/mock-object', (route) =>
    route.fulfill({ status: 200, headers: { etag: '"e2e-etag"' }, body: '' }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (await handleCommon(route, path)) return;
    if (path === '/api/v1/documents') return json(route, envelope(emptyPage()));
    if (path === '/api/v1/jobs') {
      return json(
        route,
        envelope({ items: state.uploadComplete ? [job()] : [], page: cursorPage() }),
      );
    }
    if (path === '/api/v1/uploads' && request.method() === 'POST') {
      const body = request.postDataJSON() as { files: { clientFileId: string }[] };
      state.clientFileId = body.files[0]!.clientFileId;
      return json(route, envelope(uploadSession(state.clientFileId, false)), 201);
    }
    if (path === `/api/v1/uploads/${id.upload}/complete`) {
      state.uploadComplete = true;
      return json(
        route,
        envelope({
          uploadSession: uploadSession(state.clientFileId, true),
          document: document(),
          documentVersion: documentVersion(),
          file: documentFile(),
          job: job(),
        }),
        201,
      );
    }
    if (path === `/api/v1/uploads/${id.upload}`) {
      return json(route, envelope(uploadSession(state.clientFileId, state.uploadComplete)));
    }
    return notFound(route, path);
  });

  await page.goto('/tasks');
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: '企业制度.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 制度'),
  });
  await expect(page.getByText('企业制度.md')).toBeVisible();
  await page.getByRole('button', { name: '创建直传任务' }).click();
  await expect(page.getByText('已进入后端任务队列')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('PUBLISH')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('SUCCEEDED').first()).toBeVisible();
});

test('WEB-028 审核台打开原文/Chunk 双栏且空态可行动', async ({ page }) => {
  await commonRoutes(page);
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (await handleCommon(route, path)) return;
    if (path === `/api/v1/document-versions/${id.version}/parse-runs`) {
      return json(route, envelope({ items: [] }));
    }
    if (path === `/api/v1/document-versions/${id.version}/knowledge-runs`) {
      return json(route, envelope({ items: [] }));
    }
    return notFound(route, path);
  });

  await page.goto('/reviews');
  await page.getByLabel('文档版本 UUID').fill(id.version);
  await page.getByRole('button', { name: '打开审核证据' }).click();
  await expect(page.getByText('原文定位与解析 Block')).toBeVisible();
  await expect(page.getByText('质量问题与知识切块')).toBeVisible();
  await expect(page.getByText('文件解析与OCR 尚未生成解析运行')).toBeVisible();
});

test('WEB-028 检索测试展示 Dense/Sparse、RRF、Rerank 与剔除摘要', async ({ page }) => {
  await commonRoutes(page);
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (await handleCommon(route, path)) return;
    if (path === `/api/v1/runs/${id.run}/retrieval-debug`) {
      return json(route, envelope(retrievalDebug()), 201);
    }
    if (path === `/api/v1/runs/${id.run}/steps`) {
      return json(route, envelope({ items: [rerankStep()] }));
    }
    return notFound(route, path);
  });

  await page.goto('/retrieval-lab');
  await page.getByLabel('Run UUID').fill(id.run);
  await page.getByRole('button', { name: '执行授权检索调试' }).click();
  await expect(page.getByRole('strong').filter({ hasText: /^KNOWLEDGE$/ })).toBeVisible();
  await expect(page.getByText('Dense / Sparse 路线')).toBeVisible();
  await expect(page.getByText('企业制度来源')).toBeVisible();
  await expect(page.getByText('权限版本不匹配')).toBeVisible();
  await expect(page.getByText(/candidateCount/)).toBeVisible();
});

async function commonRoutes(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('rag.dev.identity-preset', 'admin'));
}

async function handleCommon(route: Route, path: string): Promise<boolean> {
  if (path === '/api/v1/auth/dev/presets') {
    await json(
      route,
      envelope({
        selectionHeader: 'x-rag-mock-user',
        defaultPresetId: 'admin',
        items: [
          { presetId: 'admin', label: '管理员', userId: 'e2e-admin', roles: ['SYSTEM_ADMIN'] },
        ],
      }),
    );
    return true;
  }
  if (path === '/api/v1/auth/me') {
    await json(
      route,
      envelope({
        user: { userId: 'e2e-admin', roles: ['SYSTEM_ADMIN'], authzVersion: 1, resolvedAt: now },
        authMode: 'mock',
        appEnv: 'development',
      }),
    );
    return true;
  }
  if (path === '/api/v1/spaces') {
    await json(route, envelope({ items: [space()], total: 1 }));
    return true;
  }
  return false;
}

function envelope(data: unknown): Record<string, unknown> {
  return { requestId: 'e2e-request', traceId: 'e2e-trace', data };
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function notFound(route: Route, path: string): Promise<void> {
  return json(
    route,
    { requestId: 'e2e', code: 'NOT_FOUND', message: `未模拟 ${path}`, retryable: false },
    404,
  );
}

function cursorPage(): Record<string, unknown> {
  return { nextCursor: null, hasMore: false };
}

function emptyPage(): Record<string, unknown> {
  return { items: [], page: cursorPage() };
}

function space(): Record<string, unknown> {
  return {
    id: id.space,
    code: 'enterprise-policy',
    name: '企业制度库',
    description: '合成验收空间',
    ownerUserId: 'e2e-admin',
    status: 'ACTIVE',
    version: 1,
    policyVersion: 1,
    documentCount: 1,
    createdAt: now,
    updatedAt: now,
    effectivePermissions: ['READ', 'WRITE', 'REVIEW', 'ADMIN'],
  };
}

function uploadSession(clientFileId: string, completed: boolean): Record<string, unknown> {
  return {
    id: id.upload,
    spaceId: id.space,
    status: completed ? 'COMPLETED' : 'ACTIVE',
    expiresAt: '2026-08-23T09:00:00.000Z',
    createdAt: now,
    files: [
      {
        fileId: id.file,
        clientFileId,
        originalFileName: '企业制度.md',
        sizeBytes: 8,
        contentType: 'text/markdown',
        strategy: 'SINGLE',
        partSizeBytes: 8,
        partCount: 1,
        uploadUrl: completed ? null : 'http://127.0.0.1:4173/mock-object',
        expiresAt: '2026-08-23T09:00:00.000Z',
        completed,
      },
    ],
  };
}

function document(): Record<string, unknown> {
  return {
    id: id.document,
    spaceId: id.space,
    title: '企业制度',
    status: 'ACTIVE',
    latestVersionNumber: 1,
    version: 1,
    latestFileName: '企业制度.md',
    latestContentType: 'text/markdown',
    createdBy: 'e2e-admin',
    createdAt: now,
    updatedAt: now,
  };
}

function documentVersion(): Record<string, unknown> {
  return {
    id: id.version,
    documentId: id.document,
    versionNumber: 1,
    contentRevision: 1,
    status: 'SUCCEEDED',
    optimisticVersion: 1,
    createdBy: 'e2e-admin',
    createdAt: now,
    updatedAt: now,
  };
}

function documentFile(): Record<string, unknown> {
  return {
    id: id.documentFile,
    documentVersionId: id.version,
    originalFileName: '企业制度.md',
    bucket: 'rag-quarantine',
    objectKey: `spaces/${id.space}/files/${id.file}`,
    sizeBytes: 8,
    contentType: 'text/markdown',
    etag: 'e2e-etag',
    sha256: null,
    createdAt: now,
  };
}

function job(): Record<string, unknown> {
  return {
    id: 'job:e2e:publish',
    documentId: id.document,
    documentVersionId: id.version,
    contentRevision: 1,
    pipelineVersion: 1,
    status: 'SUCCEEDED',
    currentStep: 'PUBLISH',
    overallPercent: 100,
    publicMessage: '索引已验证并原子发布',
    attempt: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    steps: [],
  };
}

function retrievalDebug(): Record<string, unknown> {
  return {
    runId: id.run,
    route: 'KNOWLEDGE',
    planSha256: 'e'.repeat(64),
    planSource: 'DETERMINISTIC',
    roundCount: 1,
    subQuestionCount: 1,
    exactLiteralKinds: [],
    cacheHit: false,
    degraded: false,
    routes: [
      { route: 'DENSE', status: 'SUCCEEDED', hitCount: 10, errorCode: null },
      { route: 'SPARSE', status: 'SUCCEEDED', hitCount: 8, errorCode: null },
    ],
    removedByReason: { 权限版本不匹配: 2 },
    candidates: [
      {
        rank: 1,
        vectorId: id.vector,
        spaceId: id.space,
        documentId: id.document,
        documentVersionId: id.version,
        chunkId: id.chunk,
        title: '企业制度来源',
        headingPath: ['审批'],
        denseRank: 1,
        sparseRank: 2,
        rrfScore: 0.032,
      },
    ],
  };
}

function rerankStep(): Record<string, unknown> {
  return {
    id: '038f6c1a-5412-7cc0-b242-92aa0f56f900',
    runId: id.run,
    nodeKey: 'rerank',
    attempt: 1,
    status: 'SUCCEEDED',
    inputSummary: { candidateCount: 18 },
    outputSummary: { candidateCount: 8, modelRevision: 'fixture-v1' },
    durationMs: 42,
    errorCode: null,
    errorMessage: null,
    traceId: 'e2e-trace',
    startedAt: now,
    completedAt: now,
  };
}
