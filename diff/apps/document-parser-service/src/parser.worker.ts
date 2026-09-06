/**
 * Parser Worker 线程入口与父子线程消息契约。
 *
 * 每个不可信文档在独立 Worker 中执行同步/异步格式库；父线程超时或客户端取消时可以直接
 * terminate 当前 Worker，从而弥补 Cheerio、ExcelJS、Mammoth 等同步 CPU 阶段无法及时响应
 * AbortSignal 的缺口。这里不启动 HTTP、不访问数据库，也不记录文件名或正文。
 *
 * @requirement PAR-013
 * @requirement PAR-017
 */
import type { ParserResult } from '@rag/contracts';
import {
  createDocumentParserRegistry,
  DocumentParserError,
  type DocumentParserInput,
  type DocumentParserLimits,
  type ParserRegistryIdentity,
} from '@rag/document-parser-core';
import { parentPort, workerData } from 'node:worker_threads';

/** 父线程传给 Parser Worker 的不可变任务。 */
export interface ParserWorkerRequest {
  readonly kind: 'RAG_DOCUMENT_PARSER_WORKER_V1';
  readonly input: DocumentParserInput;
  readonly limits: DocumentParserLimits;
  readonly identity: ParserRegistryIdentity;
}

/** Worker 成功时只返回既有 Parser v2 结果，不引入第二套业务协议。 */
export interface ParserWorkerSuccess {
  readonly ok: true;
  readonly result: ParserResult;
}

/** Worker 失败消息只保留稳定分类；不跨线程传递堆栈、正文或第三方私有错误。 */
export interface ParserWorkerFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly failureClass: 'DOCUMENT_PROBLEM' | 'DEVELOPER_DEFECT' | 'RETRYABLE_PROVIDER';
    readonly httpStatus: number;
    readonly retryable: boolean;
  };
}

/** 父线程唯一接受的 Worker 响应联合类型。 */
export type ParserWorkerResponse = ParserWorkerSuccess | ParserWorkerFailure;

/** 判断当前 main bundle 是否由 ParserExecutor 作为 Worker 启动。 */
export function isParserWorkerRequest(value: unknown): value is ParserWorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (value as { kind?: unknown }).kind === 'RAG_DOCUMENT_PARSER_WORKER_V1';
}

/**
 * 在 Worker 内创建短生命周期 Registry 并完成一次解析。
 * 父线程通过 terminate 提供硬取消，因此线程内信号只负责格式循环的正常检查点。
 */
export async function runParserWorker(request: ParserWorkerRequest): Promise<void> {
  if (!parentPort) throw new Error('Parser Worker 缺少 parentPort');
  const registry = createDocumentParserRegistry(request.limits, request.identity);
  try {
    const result = await registry.parse(request.input, new AbortController().signal);
    parentPort.postMessage({ ok: true, result } satisfies ParserWorkerSuccess);
  } catch (error) {
    const normalized = normalizeWorkerError(error);
    parentPort.postMessage({ ok: false, error: normalized } satisfies ParserWorkerFailure);
  }
}

/** 是否由 worker_threads 启动；main.ts 使用它决定启动 HTTP 还是处理单个文档。 */
export function currentParserWorkerRequest(): ParserWorkerRequest | null {
  return isParserWorkerRequest(workerData) ? workerData : null;
}

/** 把任意异常收敛成低敏感、可恢复的稳定错误分类。 */
function normalizeWorkerError(error: unknown): ParserWorkerFailure['error'] {
  if (error instanceof DocumentParserError) {
    return {
      code: error.code,
      message: error.message,
      failureClass: error.failureClass,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
    };
  }
  return {
    code: 'PARSER_WORKER_UNEXPECTED',
    message: 'Parser Worker 发生未分类异常',
    failureClass: 'DEVELOPER_DEFECT',
    httpStatus: 500,
    retryable: false,
  };
}
