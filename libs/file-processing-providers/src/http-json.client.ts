/** 有上限、可取消、有限重试的 Provider JSON 客户端。 */
import { ProcessingProviderError } from './provider.error';

export interface ProviderHttpClientConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxAttempts?: number;
}

export type FetchImplementation = typeof fetch;

/** 只在 429/5xx/网络错误上有限重试；4xx 文档错误不重试。 */
export async function postProviderJson(
  config: ProviderHttpClientConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
  fetchImplementation: FetchImplementation = fetch,
): Promise<unknown> {
  const attempts = config.maxAttempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await postOnce(config, path, body, signal, fetchImplementation);
    } catch (error) {
      lastError = error;
      if (signal.aborted || !isRetryable(error) || attempt === attempts) throw error;
      await abortableDelay(Math.min(100 * 2 ** (attempt - 1), 1_000), signal);
    }
  }
  throw lastError;
}

async function postOnce(
  config: ProviderHttpClientConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
  fetchImplementation: FetchImplementation,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetchImplementation(new URL(path, ensureTrailingSlash(config.baseUrl)), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new ProcessingProviderError(
      'RETRYABLE_PROVIDER',
      timeout.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
      timeout.aborted ? 'Provider 调用超时' : 'Provider 网络调用失败',
      { cause: error },
    );
  }

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new ProcessingProviderError(
      retryable ? 'RETRYABLE_PROVIDER' : 'DOCUMENT_PROBLEM',
      `PROVIDER_HTTP_${response.status}`,
      retryable ? 'Provider 暂时不可用' : 'Provider 拒绝处理该文档',
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readResponseWithLimit(response, config.maxResponseBytes, combined);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ProcessingProviderError) throw error;
    throw new ProcessingProviderError(
      'RETRYABLE_PROVIDER',
      timeout.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_RESPONSE_IO_ERROR',
      timeout.aborted ? 'Provider 响应超时' : 'Provider 响应读取失败',
      { cause: error },
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new ProcessingProviderError(
      'DEVELOPER_DEFECT',
      'PROVIDER_INVALID_JSON',
      'Provider 返回了无效 JSON',
      { cause: error },
    );
  }
}

/** 流式读取响应并在超限时立即取消 reader，避免恶意响应耗尽内存。 */
async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel(signal.reason);
      throw signal.reason;
    }
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('response too large');
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'PROVIDER_RESPONSE_TOO_LARGE',
        'Provider 响应超过配置上限',
      );
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isRetryable(error: unknown): boolean {
  return error instanceof ProcessingProviderError && error.failureClass === 'RETRYABLE_PROVIDER';
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
