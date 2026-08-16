import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformApiFetch, setSelectedDevelopmentPreset } from './platformApi';

describe('[AUTH-003] Platform API client', () => {
  afterEach(() => vi.restoreAllMocks());
  it('开发模式只发送 presetId，不发送 userId 或 roles', async () => {
    setSelectedDevelopmentPreset('knowledge-reader');
    const fetchMock = vi.spyOn(window, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ requestId: 'request-1', data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await platformApiFetch(
      '/api/v1/example',
      z.object({ requestId: z.string(), data: z.object({ ok: z.boolean() }) }),
    );

    const requestInit = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(requestInit?.headers);
    expect(headers.get('x-rag-mock-user')).toBe('knowledge-reader');
    expect(headers.has('x-authenticated-user')).toBe(false);
    expect(headers.has('x-authenticated-roles')).toBe(false);
  });
});
