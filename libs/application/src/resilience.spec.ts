/** @requirement OPS-008 */
import { CircuitBreaker, CircuitOpenError, executeResilientCall } from './resilience';

describe('[OPS-008] executeResilientCall', () => {
  it('只重试白名单瞬时错误并最终成功', async () => {
    const call = jest
      .fn<Promise<string>, [{ signal: AbortSignal; attempt: number }]>()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce('ok');
    await expect(
      executeResilientCall(call, {
        operation: 'test',
        deadlineAt: new Date(Date.now() + 1_000),
        singleAttemptTimeoutMs: 100,
        maxAttempts: 2,
        retryBaseDelayMs: 1,
        retryMaximumDelayMs: 1,
        signal: new AbortController().signal,
        classify: () => 'TRANSIENT',
      }),
    ).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('Schema 错误不重试', async () => {
    const call = jest.fn(async () => Promise.reject(new Error('schema')));
    await expect(
      executeResilientCall(call, {
        operation: 'test',
        deadlineAt: new Date(Date.now() + 1_000),
        singleAttemptTimeoutMs: 100,
        maxAttempts: 3,
        retryBaseDelayMs: 1,
        retryMaximumDelayMs: 1,
        signal: new AbortController().signal,
        classify: () => 'SCHEMA',
      }),
    ).rejects.toThrow('schema');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('父 AbortSignal 取消后不再重试', async () => {
    const controller = new AbortController();
    const call = jest.fn(async () => {
      controller.abort(new Error('cancelled'));
      throw new Error('socket');
    });
    await expect(
      executeResilientCall(call, {
        operation: 'test',
        deadlineAt: new Date(Date.now() + 1_000),
        singleAttemptTimeoutMs: 100,
        maxAttempts: 3,
        retryBaseDelayMs: 1,
        retryMaximumDelayMs: 1,
        signal: controller.signal,
        classify: () => 'TRANSIENT',
      }),
    ).rejects.toThrow('socket');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('连续失败打开熔断并阻止新调用', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, openDurationMs: 10_000 });
    breaker.recordFailure(1_000);
    breaker.recordFailure(1_000);
    expect(() => breaker.beforeCall(1_001)).toThrow(CircuitOpenError);
  });
});
