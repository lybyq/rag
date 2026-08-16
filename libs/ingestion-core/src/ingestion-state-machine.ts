/**
 * 文档版本、任务和步骤状态机。
 * 状态转换集中在一处，避免 Controller、Worker 和 Scheduler 各自发明规则。
 *
 * @requirement DOC-002
 * @requirement DOC-012
 */
import type { DocumentVersionStatus, IngestionExecutionStatus } from '@rag/contracts';

/** 非法状态跳转使用稳定领域错误，调用层可映射为 HTTP 409。 */
export class IllegalIngestionTransitionError extends Error {
  public constructor(
    public readonly aggregate: 'DOCUMENT_VERSION' | 'JOB' | 'STEP',
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`${aggregate} 不允许从 ${from} 跳转到 ${to}`);
    this.name = 'IllegalIngestionTransitionError';
  }
}

/** 文档版本终态不能回退；重处理通过新 content revision 重新进入 QUEUED。 */
const documentVersionTransitions: Readonly<
  Record<DocumentVersionStatus, readonly DocumentVersionStatus[]>
> = {
  UPLOADING: ['QUEUED', 'CANCELLED', 'REJECTED'],
  QUEUED: ['PROCESSING', 'CANCELLED', 'REJECTED'],
  PROCESSING: ['WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REJECTED'],
  WAITING: ['PROCESSING', 'FAILED', 'CANCELLED', 'REJECTED'],
  SUCCEEDED: ['QUEUED'],
  FAILED: ['QUEUED'],
  CANCELLED: ['QUEUED'],
  REJECTED: ['QUEUED'],
};

/** 任务和步骤共享执行状态，但允许的恢复路径有严格边界。 */
const executionTransitions: Readonly<
  Record<IngestionExecutionStatus, readonly IngestionExecutionStatus[]>
> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'REJECTED'],
  RUNNING: ['WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REJECTED'],
  WAITING: ['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED', 'REJECTED'],
  SUCCEEDED: [],
  FAILED: ['QUEUED'],
  CANCELLED: [],
  REJECTED: [],
};

/** 断言文档版本状态跳转合法；相同状态用于幂等重放。 */
export function assertDocumentVersionTransition(
  from: DocumentVersionStatus,
  to: DocumentVersionStatus,
): void {
  if (from === to) return;
  if (!documentVersionTransitions[from].includes(to)) {
    throw new IllegalIngestionTransitionError('DOCUMENT_VERSION', from, to);
  }
}

/** 断言任务状态跳转合法；相同状态不重复制造事件。 */
export function assertJobTransition(
  from: IngestionExecutionStatus,
  to: IngestionExecutionStatus,
): void {
  if (from === to) return;
  if (!executionTransitions[from].includes(to)) {
    throw new IllegalIngestionTransitionError('JOB', from, to);
  }
}

/** 断言步骤状态跳转合法。 */
export function assertStepTransition(
  from: IngestionExecutionStatus,
  to: IngestionExecutionStatus,
): void {
  if (from === to) return;
  if (!executionTransitions[from].includes(to)) {
    throw new IllegalIngestionTransitionError('STEP', from, to);
  }
}

/** 判断是否为不可继续执行的终态。 */
export function isTerminalExecutionStatus(status: IngestionExecutionStatus): boolean {
  return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'REJECTED'].includes(status);
}
