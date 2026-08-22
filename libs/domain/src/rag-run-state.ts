/**
 * M06 Run 与 Graph Step 的纯状态机规则。
 *
 * Domain 不依赖 NestJS、PostgreSQL 或 Redis；Repository 在执行乐观锁更新前调用这些规则。
 * 终态不可逆可以阻止超时扫描、取消请求和模型完成回调互相覆盖事实。
 *
 * @requirement RUN-005
 * @requirement RUN-010
 * @requirement RUN-011
 */
import type { RagRunStatus, RagRunStepStatus } from '@rag/contracts';

const runTransitions: Readonly<Record<RagRunStatus, readonly RagRunStatus[]>> = {
  ACCEPTED: ['RUNNING', 'CANCELLING', 'FAILED', 'EXPIRED'],
  RUNNING: ['CANCELLING', 'COMPLETED', 'FAILED', 'EXPIRED'],
  CANCELLING: ['CANCELLED', 'FAILED', 'EXPIRED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

const stepTransitions: Readonly<Record<RagRunStepStatus, readonly RagRunStepStatus[]>> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'SKIPPED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  SKIPPED: [],
};

/** 非法状态迁移错误不包含问题正文或 Provider 响应。 */
export class IllegalRagRunTransitionError extends Error {
  public constructor(from: RagRunStatus, to: RagRunStatus) {
    super(`非法 Run 状态迁移：${from} -> ${to}`);
    this.name = 'IllegalRagRunTransitionError';
  }
}

/** 非法 Graph 节点状态迁移错误。 */
export class IllegalRagRunStepTransitionError extends Error {
  public constructor(from: RagRunStepStatus, to: RagRunStepStatus) {
    super(`非法 Run Step 状态迁移：${from} -> ${to}`);
    this.name = 'IllegalRagRunStepTransitionError';
  }
}

/** 断言 Run 状态迁移合法；相同状态也视为非法，幂等由 Repository 读取现状处理。 */
export function assertRagRunTransition(from: RagRunStatus, to: RagRunStatus): void {
  if (!runTransitions[from].includes(to)) throw new IllegalRagRunTransitionError(from, to);
}

/** 断言 Graph Step 状态迁移合法。 */
export function assertRagRunStepTransition(from: RagRunStepStatus, to: RagRunStepStatus): void {
  if (!stepTransitions[from].includes(to)) throw new IllegalRagRunStepTransitionError(from, to);
}

/** Run 是否已经进入不可逆终态。 */
export function isTerminalRagRunStatus(status: RagRunStatus): boolean {
  return runTransitions[status].length === 0;
}
