/**
 * M06 AbortSignal 注册表单元门禁。
 * 验证同一 Run 共享取消信号、取消幂等，以及终态释放后不会污染下一次执行。
 *
 * @requirement RUN-010
 */
import { RagRunCancellationRegistry } from './rag-run-cancellation';

describe('[RUN-010] RagRunCancellationRegistry', () => {
  test('同一 Run 共享 Signal，取消会立即传播且可幂等调用', () => {
    const registry = new RagRunCancellationRegistry();
    const first = registry.signal('run-1');
    const second = registry.signal('run-1');

    expect(second).toBe(first);
    registry.cancel('run-1', '用户取消');
    registry.cancel('run-1', '重复取消');

    expect(first.aborted).toBe(true);
    expect((first.reason as Error).message).toBe('用户取消');
  });

  test('终态释放后为同名 Run 返回全新的未取消 Signal', () => {
    const registry = new RagRunCancellationRegistry();
    const previous = registry.signal('run-2');
    registry.cancel('run-2', '执行结束');
    registry.release('run-2');

    const next = registry.signal('run-2');
    expect(next).not.toBe(previous);
    expect(next.aborted).toBe(false);
  });
});
