/**
 * 独立 Node Parser Service 进程入口。
 * Worker 分支只加载 Parser Core；HTTP 分支才注册 OpenTelemetry 和 Nest，避免观测定时器延长
 * 单任务 Worker 生命周期。服务只暴露版本化 Parser 协议、健康和指标。
 *
 * @requirement PAR-004
 */
import { currentParserWorkerRequest, runParserWorker } from './parser.worker';

const workerRequest = currentParserWorkerRequest();
if (workerRequest) {
  void runParserWorker(workerRequest);
} else {
  void bootstrapParserHttpService();
}

/** OpenTelemetry 必须先于 Nest/HTTP 模块加载，动态导入顺序不能交换。 */
async function bootstrapParserHttpService(): Promise<void> {
  await import('@rag/observability/register');
  const [{ bootstrapHttpApplication }, { DocumentParserServiceModule }] = await Promise.all([
    import('@rag/observability'),
    import('./app.module'),
  ]);
  await bootstrapHttpApplication(DocumentParserServiceModule, {
    portKind: 'http',
    globalPrefix: 'v1',
  });
}
