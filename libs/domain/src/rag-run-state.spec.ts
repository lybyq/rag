/** M06 Run/Step 状态机的终态与竞态测试。 */
import {
  IllegalRagRunStepTransitionError,
  IllegalRagRunTransitionError,
  assertRagRunStepTransition,
  assertRagRunTransition,
  isTerminalRagRunStatus,
} from './rag-run-state';

describe('[RUN-005][RUN-010][RUN-011] rag run state machine', () => {
  test('允许 ACCEPTED 开始执行并完成', () => {
    expect(() => assertRagRunTransition('ACCEPTED', 'RUNNING')).not.toThrow();
    expect(() => assertRagRunTransition('RUNNING', 'COMPLETED')).not.toThrow();
  });

  test('取消开始后禁止晚到的完成回调覆盖取消事实', () => {
    expect(() => assertRagRunTransition('RUNNING', 'CANCELLED')).toThrow(
      IllegalRagRunTransitionError,
    );
    expect(() => assertRagRunTransition('CANCELLING', 'COMPLETED')).toThrow(
      IllegalRagRunTransitionError,
    );
    expect(() => assertRagRunTransition('CANCELLING', 'CANCELLED')).not.toThrow();
  });

  test('所有终态不可逆', () => {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const) {
      expect(isTerminalRagRunStatus(status)).toBe(true);
      expect(() => assertRagRunTransition(status, 'RUNNING')).toThrow(IllegalRagRunTransitionError);
    }
  });

  test('Step 只能从 RUNNING 进入成功或失败', () => {
    expect(() => assertRagRunStepTransition('QUEUED', 'SUCCEEDED')).toThrow(
      IllegalRagRunStepTransitionError,
    );
    expect(() => assertRagRunStepTransition('QUEUED', 'RUNNING')).not.toThrow();
    expect(() => assertRagRunStepTransition('RUNNING', 'SUCCEEDED')).not.toThrow();
  });
});
