/** @requirement OPS-007 在线问答四维流控的行为测试。 */
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { TrafficControlPort } from '@rag/application';
import type { AppConfig } from '@rag/config';
import { createTrustedUserContext } from '@rag/contracts-internal/user-context';
import { firstValueFrom, of } from 'rxjs';
import { TrafficControlInterceptor } from './traffic-control.interceptor';

describe('TrafficControlInterceptor', () => {
  it('创建 Run 按全局、用户、角色、空间申请并在完成后全部释放', async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const traffic: TrafficControlPort = {
      acquire: jest.fn(async (request) => {
        acquired.push(request.bucket);
        return { allowed: true as const, leaseId: `lease-${acquired.length}` };
      }),
      release: jest.fn(async (leaseId) => void released.push(leaseId)),
    };
    const interceptor = new TrafficControlInterceptor(traffic, config());
    await firstValueFrom(
      await interceptor.intercept(context(), { handle: () => of('ok') } as CallHandler),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(acquired).toEqual(['global', 'user', 'role', 'space']);
    expect(released).toHaveLength(4);
  });
});

function context(): ExecutionContext {
  const request = {
    method: 'POST',
    originalUrl: '/api/v1/conversations/018f6c1a-5412-7cc0-b242-92aa0f56f901/runs',
    body: { requestedSpaceIds: ['018f6c1a-5412-7cc0-b242-92aa0f56f902'] },
    userContext: createTrustedUserContext({
      userId: 'user-1',
      roles: ['KNOWLEDGE_READER'],
      authzVersion: 1,
      resolvedAt: '2026-08-23T00:00:00.000Z',
    }),
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function config(): AppConfig {
  return {
    trafficControl: {
      globalRatePerMinute: 600,
      globalConcurrency: 200,
      userRatePerMinute: 60,
      userConcurrency: 4,
      roleRatePerMinute: 300,
      roleConcurrency: 100,
      spaceRatePerMinute: 300,
      spaceConcurrency: 50,
      leaseSeconds: 120,
    },
  } as AppConfig;
}
