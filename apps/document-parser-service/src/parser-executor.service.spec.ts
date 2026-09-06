/**
 * Parser Worker 执行器回归测试。
 * 使用内存 EventEmitter 模拟线程事件，验证硬取消、背压和跨线程错误，不创建大文件。
 *
 * @requirement PAR-013
 * @requirement PAR-017
 */
import { createDocumentParserRegistry, type DocumentParserLimits } from '@rag/document-parser-core';
import { EventEmitter } from 'node:events';
import {
  WorkerDocumentParserExecutor,
  type ParserWorkerFactory,
  type ParserWorkerHandle,
} from './parser-executor.service';

const limits: DocumentParserLimits = {
  maxArchiveDepth: 3,
  maxCompressionRatio: 100,
  maxPages: 10,
  maxTotalPixels: 1_000_000,
  maxTableCells: 1_000,
  maxExpandedTableCells: 2_000,
  maxTableRows: 100,
  maxTableColumns: 100,
  maxTableSpan: 100,
  maxOutputCharacters: 10_000,
  maxInputBytes: 1_000_000,
  maxArchiveEntries: 100,
  maxXmlEntryBytes: 1_000_000,
};
const identity = { revision: 'worker-test-r1', protocolVersion: '2' };
const input = {
  bytes: Buffer.from('正文'),
  fileName: 'worker.txt',
  format: 'TEXT' as const,
  declaredMime: 'text/plain',
};

describe('[PAR-013][PAR-017] WorkerDocumentParserExecutor', () => {
  it('返回通过 ParserResult 契约校验的 Worker 成功结果', async () => {
    const expected = await createDocumentParserRegistry(limits, identity).parse(
      input,
      new AbortController().signal,
    );
    const factory = emittingWorkerFactory({ ok: true, result: expected });
    const executor = new WorkerDocumentParserExecutor(
      limits,
      identity,
      1,
      'parser-main.js',
      factory,
    );

    await expect(executor.parse(input, new AbortController().signal)).resolves.toEqual(expected);
  });

  it('调用方取消会 terminate 当前 Worker，并原样传播取消原因', async () => {
    const worker = new FakeWorker();
    const executor = new WorkerDocumentParserExecutor(
      limits,
      identity,
      1,
      'parser-main.js',
      () => worker,
    );
    const controller = new AbortController();
    const pending = executor.parse(input, controller.signal);
    controller.abort(new Error('cancel-parser-worker'));

    await expect(pending).rejects.toThrow('cancel-parser-worker');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('并发满载立即返回可重试 503，避免在内存排队整份文件', async () => {
    const worker = new FakeWorker();
    const executor = new WorkerDocumentParserExecutor(
      limits,
      identity,
      1,
      'parser-main.js',
      () => worker,
    );
    const firstController = new AbortController();
    const first = executor.parse(input, firstController.signal);

    await expect(executor.parse(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'PARSER_CAPACITY_EXCEEDED',
      httpStatus: 503,
      retryable: true,
    });
    firstController.abort(new Error('test-cleanup'));
    await expect(first).rejects.toThrow('test-cleanup');
  });

  it('保留 Worker 内稳定错误分类，但不依赖跨线程 Error 原型', async () => {
    const factory = emittingWorkerFactory({
      ok: false,
      error: {
        code: 'TABLE_ROW_LIMIT_EXCEEDED',
        message: '表格行数超过 Parser 资源上限',
        failureClass: 'DOCUMENT_PROBLEM',
        httpStatus: 422,
        retryable: false,
      },
    });
    const executor = new WorkerDocumentParserExecutor(
      limits,
      identity,
      1,
      'parser-main.js',
      factory,
    );

    await expect(executor.parse(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'TABLE_ROW_LIMIT_EXCEEDED',
      failureClass: 'DOCUMENT_PROBLEM',
    });
  });
});

/** 只实现执行器使用到的 Worker 事件与终止表面。 */
class FakeWorker extends EventEmitter {
  public readonly terminate = jest.fn(async () => 0);
}

/** 在监听器安装后的微任务中发送一条 Worker 消息。 */
function emittingWorkerFactory(message: unknown): ParserWorkerFactory {
  return () => {
    const worker = new FakeWorker();
    queueMicrotask(() => worker.emit('message', message));
    return worker as unknown as ParserWorkerHandle;
  };
}
