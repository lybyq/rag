/** OpenTelemetry 必须先于 Worker 依赖注册，探针端口仅用于运维。 */
import '@rag/observability/register';
import { bootstrapHttpApplication } from '@rag/observability';
import { SchedulerWorkerModule } from './app.module';

void bootstrapHttpApplication(SchedulerWorkerModule, { portKind: 'probe' });
