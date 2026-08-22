/**
 * M06 进程内 AbortSignal 协调器。
 *
 * Graph 执行器按 runId 取得 Signal，并把它继续传给检索、Reranker 和 LLM Port。
 * API 本实例会立即取消；Redis Adapter 还会广播取消事件，让其他副本取消本地执行。
 *
 * @requirement RUN-010
 */
import type { RagRunCancellationPort } from './rag-run.ports';

/** 基于 AbortController 的 Run 取消注册表。 */
export class RagRunCancellationRegistry implements RagRunCancellationPort {
  private readonly controllers = new Map<string, AbortController>();

  /** 获取稳定 Signal；同一个 Run 在 release 前始终返回同一对象。 */
  public signal(runId: string): AbortSignal {
    let controller = this.controllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(runId, controller);
    }
    return controller.signal;
  }

  /** 幂等广播取消，不在 reason 中携带问题或答案正文。 */
  public cancel(runId: string, reason: string): void {
    let controller = this.controllers.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(runId, controller);
    }
    if (!controller.signal.aborted) controller.abort(new Error(reason));
  }

  /** Run 进入终态后释放内存引用。 */
  public release(runId: string): void {
    this.controllers.delete(runId);
  }
}
