/**
 * 独立 Node Parser Service 进程入口。
 * OpenTelemetry 必须在 Nest/HTTP 前注册；服务只暴露版本化 Parser 协议、健康和指标。
 *
 * @requirement PAR-004
 */
import '@rag/observability/register';
import { bootstrapHttpApplication } from '@rag/observability';
import { DocumentParserServiceModule } from './app.module';

void bootstrapHttpApplication(DocumentParserServiceModule, {
  portKind: 'http',
  globalPrefix: 'v1',
});
