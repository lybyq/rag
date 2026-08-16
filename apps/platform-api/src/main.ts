/** OpenTelemetry 必须先于 NestJS 和 Node HTTP 模块注册。 */
import '@rag/observability/register';
import { bootstrapHttpApplication } from '@rag/observability';
import { PlatformApiModule } from './app.module';

void bootstrapHttpApplication(PlatformApiModule, { portKind: 'http' });
