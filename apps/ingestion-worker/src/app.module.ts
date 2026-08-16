/** 文档接入 Worker 根模块；M02 起注册 BullMQ 消费者和接入状态机。 */
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '@rag/config';
import { HealthModule } from '@rag/health';
import { ObservabilityModule } from '@rag/observability';

@Module({
  imports: [RuntimeConfigModule, ObservabilityModule, HealthModule],
})
export class IngestionWorkerModule {}
