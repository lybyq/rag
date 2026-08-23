/**
 * 外部调用的统一 Deadline、超时、重试白名单、指数退避和熔断实现。
 *
 * 这是无框架纯逻辑：Adapter 提供单次调用和错误分类，策略负责有限重试与取消传播。
 * 它不解析任何供应商响应，也不决定业务降级结果。
 *
 * @requirement OPS-008
 * @requirement NFR-006
 */

/** 远程错误分类；只有 TRANSIENT 与 RATE_LIMITED 默认允许重试。 */
export type RemoteFailureKind =
  | 'TRANSIENT'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'SCHEMA'
  | 'VERSION'
  | 'AUTHENTICATION'
  | 'TERMINAL';

/** 单次调用策略。 */
export interface ResilientCallPolicy {
  readonly operation: string;
  readonly deadlineAt: Date;
  readonly singleAttemptTimeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaximumDelayMs: number;
  readonly signal: AbortSignal;
  readonly classify: (error: unknown) => RemoteFailureKind;
  readonly circuitBreaker?: CircuitBreaker;
}

/** 熔断器配置。 */
export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly openDurationMs: number;
}

/** 熔断打开时的稳定错误。 */
export class CircuitOpenError extends Error {
  public constructor(public readonly retryAt: Date) {
    super('远程依赖熔断器已打开');
    this.name = 'CircuitOpenError';
  }
}

/**
 * 进程内熔断状态；跨实例由负载均衡与健康检查共同隔离。
 * HALF_OPEN 同时只允许一个探测调用，避免恢复瞬间的惊群。
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;
  private halfOpenProbe = false;

  public constructor(private readonly config: CircuitBreakerConfig) {}

  /** 调用前检查 OPEN/HALF_OPEN。 */
  public beforeCall(now = Date.now()): void {
    if (this.openUntil > now) throw new CircuitOpenError(new Date(this.openUntil));
    if (this.openUntil > 0) {
      if (this.halfOpenProbe)
        throw new CircuitOpenError(new Date(now + this.config.openDurationMs));
      this.halfOpenProbe = true;
    }
  }

  /** 成功关闭熔断并清零连续失败。 */
  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.halfOpenProbe = false;
  }

  /** 瞬时依赖失败达到阈值后打开熔断。 */
  public recordFailure(now = Date.now()): void {
    this.halfOpenProbe = false;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.openUntil = now + this.config.openDurationMs;
    }
  }
}

/**
 * 执行有限重试。
 * 每次尝试使用独立 AbortController；父取消或绝对 Deadline 到达后不会再进入退避和下一次尝试。
 */
export async function executeResilientCall<T>(
  call: (options: { readonly signal: AbortSignal; readonly attempt: number }) => Promise<T>,
  policy: ResilientCallPolicy,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    throwIfCancelledOrExpired(policy);
    policy.circuitBreaker?.beforeCall();
    const remaining = policy.deadlineAt.getTime() - Date.now();
    const attemptController = linkedTimeout(
      policy.signal,
      Math.min(policy.singleAttemptTimeoutMs, remaining),
    );
    try {
      const value = await call({ signal: attemptController.signal, attempt });
      policy.circuitBreaker?.recordSuccess();
      return value;
    } catch (error) {
      lastError = error;
      const kind = policy.signal.aborted ? 'CANCELLED' : policy.classify(error);
      if (
        kind === 'CANCELLED' ||
        kind === 'SCHEMA' ||
        kind === 'VERSION' ||
        kind === 'AUTHENTICATION' ||
        kind === 'TERMINAL'
      ) {
        throw error;
      }
      policy.circuitBreaker?.recordFailure();
      if (attempt >= policy.maxAttempts) throw error;
      const delay = Math.min(
        policy.retryMaximumDelayMs,
        policy.retryBaseDelayMs * 2 ** (attempt - 1),
      );
      await abortableDelay(
        Math.min(delay, Math.max(0, policy.deadlineAt.getTime() - Date.now())),
        policy.signal,
      );
    } finally {
      attemptController.abort();
    }
  }
  throw lastError;
}

function throwIfCancelledOrExpired(policy: ResilientCallPolicy): void {
  if (policy.signal.aborted) throw policy.signal.reason ?? new Error(`${policy.operation} 已取消`);
  if (policy.deadlineAt.getTime() <= Date.now())
    throw new Error(`${policy.operation} Deadline 已到期`);
}

function linkedTimeout(parent: AbortSignal, timeoutMs: number): AbortController {
  const controller = new AbortController();
  const fromParent = (): void => controller.abort(parent.reason);
  if (parent.aborted) fromParent();
  else parent.addEventListener('abort', fromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('远程调用单次超时')),
    Math.max(1, timeoutMs),
  );
  timer.unref();
  controller.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', fromParent);
    },
    { once: true },
  );
  return controller;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) throw new Error('远程调用 Deadline 已到期');
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(signal.reason ?? new Error('远程调用已取消'));
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener('abort', cancel, { once: true });
  });
}
