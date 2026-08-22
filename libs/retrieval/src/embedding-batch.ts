/**
 * M05 Token 感知动态批处理、有限并发、部分失败重试与背压算法。
 *
 * 该文件只组织内存中的输入和 Provider 调用，不知道 HTTP、模型厂商或数据库。
 * 调用者负责给每次 Provider 请求设置单次 Deadline；这里负责整批取消和有限重试。
 *
 * @requirement IDX-001
 * @requirement IDX-004
 */
import type {
  EmbeddingBatchResponse,
  EmbeddingInput,
  EmbeddingItemFailure,
  EmbeddingOutput,
} from '@rag/contracts';

/** 动态批次预算；两项限制必须同时满足。 */
export interface EmbeddingBatchBudget {
  readonly maxBatchItems: number;
  readonly maxBatchTokens: number;
}

/** 批处理执行策略；maxQueuedItems 是进入 Provider 前的显式背压上限。 */
export interface EmbeddingBatchExecutionOptions extends EmbeddingBatchBudget {
  readonly maxConcurrency: number;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly maxQueuedItems: number;
  readonly signal: AbortSignal;
}

/** Provider 单批调用签名。 */
export type EmbeddingBatchInvoker = (
  batch: readonly EmbeddingInput[],
) => Promise<EmbeddingBatchResponse>;

/** 完整执行结果；不可重试或耗尽次数的失败项由调用者持久化。 */
export interface EmbeddingExecutionResult {
  readonly outputs: readonly EmbeddingOutput[];
  readonly failures: readonly EmbeddingItemFailure[];
}

/**
 * 按稳定输入顺序执行 first-fit 连续分组。
 * 单条输入超过 Token 上限时立即拒绝；静默截断会改变内容 Hash 与检索语义。
 */
export function planEmbeddingBatches(
  inputs: readonly EmbeddingInput[],
  budget: EmbeddingBatchBudget,
): readonly (readonly EmbeddingInput[])[] {
  assertPositiveInteger(budget.maxBatchItems, 'maxBatchItems');
  assertPositiveInteger(budget.maxBatchTokens, 'maxBatchTokens');
  const batches: EmbeddingInput[][] = [];
  let current: EmbeddingInput[] = [];
  let currentTokens = 0;
  for (const input of inputs) {
    if (input.tokenCount > budget.maxBatchTokens) {
      throw new Error(`Embedding 输入 ${input.itemId} 超过单批 Token 上限`);
    }
    const exceedsItems = current.length >= budget.maxBatchItems;
    const exceedsTokens = currentTokens + input.tokenCount > budget.maxBatchTokens;
    if (current.length > 0 && (exceedsItems || exceedsTokens)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(input);
    currentTokens += input.tokenCount;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * 有限并发执行所有批次，并仅重试响应中明确标记 retryable 的失败项。
 * Provider 漏报、重复或返回错误 Hash 时转成 SCHEMA_ERROR，不能当成成功事实写入数据库。
 */
export async function executeEmbeddingBatches(
  inputs: readonly EmbeddingInput[],
  invoke: EmbeddingBatchInvoker,
  options: EmbeddingBatchExecutionOptions,
): Promise<EmbeddingExecutionResult> {
  assertPositiveInteger(options.maxConcurrency, 'maxConcurrency');
  assertPositiveInteger(options.maxAttempts, 'maxAttempts');
  assertPositiveInteger(options.maxQueuedItems, 'maxQueuedItems');
  if (inputs.length > options.maxQueuedItems) {
    throw new Error(
      `Embedding 背压拒绝：${inputs.length} 条超过队列上限 ${options.maxQueuedItems}`,
    );
  }
  throwIfAborted(options.signal);
  const batches = planEmbeddingBatches(inputs, options);
  const outputs = new Map<string, EmbeddingOutput>();
  const failures = new Map<string, EmbeddingItemFailure>();
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < batches.length) {
      throwIfAborted(options.signal);
      const batchIndex = cursor;
      cursor += 1;
      const batch = batches[batchIndex];
      if (batch) {
        const result = await executeOneBatch(batch, invoke, options);
        for (const output of result.outputs) outputs.set(output.itemId, output);
        for (const failure of result.failures) failures.set(failure.itemId, failure);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.maxConcurrency, batches.length) }, () => worker()),
  );
  const order = new Map(inputs.map((input, index) => [input.itemId, index]));
  return {
    outputs: [...outputs.values()].sort(byInputOrder(order)),
    failures: [...failures.values()].sort(byInputOrder(order)),
  };
}

async function executeOneBatch(
  original: readonly EmbeddingInput[],
  invoke: EmbeddingBatchInvoker,
  options: EmbeddingBatchExecutionOptions,
): Promise<EmbeddingExecutionResult> {
  const resolved = new Map<string, EmbeddingOutput>();
  const terminal = new Map<string, EmbeddingItemFailure>();
  let pending = [...original];
  for (let attempt = 1; attempt <= options.maxAttempts && pending.length > 0; attempt += 1) {
    throwIfAborted(options.signal);
    const response = await invoke(pending);
    const requested = new Map(pending.map((item) => [item.itemId, item]));
    const retry: EmbeddingInput[] = [];
    const seen = new Set<string>();

    for (const output of response.outputs) {
      const input = requested.get(output.itemId);
      if (!input || seen.has(output.itemId) || output.contentSha256 !== input.contentSha256)
        continue;
      seen.add(output.itemId);
      resolved.set(output.itemId, output);
    }
    for (const failure of response.failures) {
      const input = requested.get(failure.itemId);
      if (!input || seen.has(failure.itemId)) continue;
      seen.add(failure.itemId);
      if (failure.retryable && attempt < options.maxAttempts) retry.push(input);
      else terminal.set(failure.itemId, failure);
    }
    for (const input of pending) {
      if (seen.has(input.itemId)) continue;
      terminal.set(input.itemId, schemaFailure(input.itemId));
    }
    pending = retry;
    if (pending.length > 0) {
      await abortableDelay(options.retryBaseDelayMs * 2 ** (attempt - 1), options.signal);
    }
  }
  return { outputs: [...resolved.values()], failures: [...terminal.values()] };
}

function schemaFailure(itemId: string): EmbeddingItemFailure {
  return {
    itemId,
    code: 'SCHEMA_ERROR',
    retryable: false,
    publicMessage: 'Embedding Provider 响应缺少请求项或关联字段不一致',
  };
}

function byInputOrder<T extends { readonly itemId: string }>(
  order: ReadonlyMap<string, number>,
): (left: T, right: T) => number {
  return (left, right) =>
    (order.get(left.itemId) ?? Infinity) - (order.get(right.itemId) ?? Infinity);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Embedding 执行已取消');
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Embedding 执行已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timer.unref();
  });
}
