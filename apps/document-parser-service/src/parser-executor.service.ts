/**
 * Parser Worker 父线程执行器。
 *
 * 它负责并发背压、线程生命周期、硬取消和错误还原；格式选择与内容解析仍完全属于
 * document-parser-core。每个请求创建一个短生命周期 Worker，避免某个恶意文件阻塞 HTTP
 * 事件循环。它不下载文件、不解释正文，也不改变对外 Parser v2 契约。
 *
 * @requirement PAR-013
 * @requirement PAR-017
 */
import { ParserResultSchema, type ParserResult } from '@rag/contracts';
import {
  DocumentParserError,
  throwIfAborted,
  type DocumentParserInput,
  type DocumentParserLimits,
  type ParserRegistryIdentity,
} from '@rag/document-parser-core';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import type {
  ParserWorkerFailure,
  ParserWorkerRequest,
  ParserWorkerResponse,
} from './parser.worker';

/** Controller 只依赖这个用例端口，单测无需真正创建操作系统线程。 */
export interface DocumentParserExecutor {
  /** 在取消上下文中解析一个已经下载并校验大小的文档。 */
  parse(input: DocumentParserInput, signal: AbortSignal): Promise<ParserResult>;
}

/** 测试替身所需的最小 Worker 表面。 */
export interface ParserWorkerHandle {
  once(event: 'message', listener: (message: unknown) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  removeAllListeners(): this;
  terminate(): Promise<number>;
}

/** 创建 Worker 的可替换工厂；生产默认使用 node:worker_threads。 */
export type ParserWorkerFactory = (
  entryPoint: string,
  options: WorkerOptions,
) => ParserWorkerHandle;

/** 使用硬线程边界执行 Parser，并限制同一进程的在途解析数。 */
export class WorkerDocumentParserExecutor implements DocumentParserExecutor {
  private activeWorkers = 0;

  public constructor(
    private readonly limits: DocumentParserLimits,
    private readonly identity: ParserRegistryIdentity,
    private readonly maximumConcurrency: number,
    private readonly entryPoint = process.argv[1] ?? '',
    private readonly workerFactory: ParserWorkerFactory = (fileName, options) =>
      new Worker(fileName, options),
  ) {
    if (!Number.isInteger(maximumConcurrency) || maximumConcurrency < 1) {
      throw new DocumentParserError('PARSER_CONCURRENCY_INVALID', 'Parser Worker 并发配置无效', {
        failureClass: 'DEVELOPER_DEFECT',
        httpStatus: 500,
      });
    }
    if (!entryPoint) {
      throw new DocumentParserError('PARSER_ENTRYPOINT_MISSING', 'Parser Worker 入口文件缺失', {
        failureClass: 'DEVELOPER_DEFECT',
        httpStatus: 500,
      });
    }
  }

  /**
   * 创建单任务 Worker；取消时 terminate 是硬边界，不依赖被解析库主动让出事件循环。
   * 超过并发上限时立即返回可重试 503，避免在内存中堆积整份文件字节。
   */
  public async parse(input: DocumentParserInput, signal: AbortSignal): Promise<ParserResult> {
    throwIfAborted(signal);
    if (this.activeWorkers >= this.maximumConcurrency) {
      throw new DocumentParserError('PARSER_CAPACITY_EXCEEDED', 'Parser Worker 已达到并发上限', {
        failureClass: 'RETRYABLE_PROVIDER',
        httpStatus: 503,
        retryable: true,
      });
    }

    // slice 得到只含当前文件的独立 ArrayBuffer，转移后不会连带分离 Node Buffer 池中的其他字节。
    const transferableBytes = input.bytes.slice();
    const request: ParserWorkerRequest = {
      kind: 'RAG_DOCUMENT_PARSER_WORKER_V1',
      input: { ...input, bytes: transferableBytes },
      limits: this.limits,
      identity: this.identity,
    };
    this.activeWorkers += 1;
    let worker: ParserWorkerHandle;
    try {
      worker = this.workerFactory(this.entryPoint, {
        workerData: request,
        transferList: [transferableBytes.buffer],
      });
    } catch (error) {
      this.activeWorkers -= 1;
      throw new DocumentParserError('PARSER_WORKER_START_FAILED', 'Parser Worker 无法启动', {
        failureClass: 'RETRYABLE_PROVIDER',
        httpStatus: 503,
        retryable: true,
        cause: error,
      });
    }

    try {
      return await this.waitForWorker(worker, signal);
    } finally {
      this.activeWorkers -= 1;
    }
  }

  /** 把 message/error/exit/abort 四种竞争事件收敛成只完成一次的 Promise。 */
  private waitForWorker(worker: ParserWorkerHandle, signal: AbortSignal): Promise<ParserResult> {
    return new Promise<ParserResult>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        worker.removeAllListeners();
        action();
      };
      const onAbort = (): void => {
        settle(() => {
          void worker.terminate();
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DocumentParserError('PARSER_ABORTED', '解析任务已取消', {
                  failureClass: 'RETRYABLE_PROVIDER',
                  httpStatus: 499,
                  retryable: true,
                }),
          );
        });
      };

      worker.once('message', (message) => {
        settle(() => {
          // 单任务 Worker 完成消息后立即释放；不依赖第三方库或观测组件自行关闭句柄。
          void worker.terminate();
          const response = message as Partial<ParserWorkerResponse> | null;
          if (isWorkerFailure(response)) {
            reject(restoreWorkerError(response.error));
            return;
          }
          if (response?.ok !== true) {
            reject(workerProtocolError('Parser Worker 返回未知消息'));
            return;
          }
          const result = ParserResultSchema.safeParse(response.result);
          if (result.success) resolve(result.data);
          else reject(workerProtocolError('Parser Worker 结果不符合 ParserResult 契约'));
        });
      });
      worker.once('error', (error) => {
        settle(() =>
          reject(
            new DocumentParserError('PARSER_WORKER_CRASHED', 'Parser Worker 异常退出', {
              failureClass: 'RETRYABLE_PROVIDER',
              httpStatus: 503,
              retryable: true,
              cause: error,
            }),
          ),
        );
      });
      worker.once('exit', (code) => {
        settle(() =>
          reject(
            new DocumentParserError('PARSER_WORKER_EXITED', `Parser Worker 提前退出（${code}）`, {
              failureClass: 'RETRYABLE_PROVIDER',
              httpStatus: 503,
              retryable: true,
            }),
          ),
        );
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}

/** 对失败消息做最小运行时校验，防止损坏消息在父线程形成未捕获 TypeError。 */
function isWorkerFailure(value: unknown): value is ParserWorkerFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { ok?: unknown; error?: Record<string, unknown> };
  if (candidate.ok !== false || !candidate.error) return false;
  return (
    typeof candidate.error.code === 'string' &&
    typeof candidate.error.message === 'string' &&
    (candidate.error.failureClass === 'DOCUMENT_PROBLEM' ||
      candidate.error.failureClass === 'DEVELOPER_DEFECT' ||
      candidate.error.failureClass === 'RETRYABLE_PROVIDER') &&
    typeof candidate.error.httpStatus === 'number' &&
    typeof candidate.error.retryable === 'boolean'
  );
}

/** 还原 core 可识别的稳定错误，而不是把 Worker 私有异常透传到 HTTP。 */
function restoreWorkerError(error: ParserWorkerFailure['error']): DocumentParserError {
  return new DocumentParserError(error.code, error.message, {
    failureClass: error.failureClass,
    httpStatus: error.httpStatus,
    retryable: error.retryable,
  });
}

/** 内部消息损坏属于部署/版本缺陷，不应按用户文档问题处理。 */
function workerProtocolError(message: string): DocumentParserError {
  return new DocumentParserError('PARSER_WORKER_PROTOCOL_INVALID', message, {
    failureClass: 'DEVELOPER_DEFECT',
    httpStatus: 500,
  });
}
