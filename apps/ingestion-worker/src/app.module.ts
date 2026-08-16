/** 文档接入 Worker 根模块；M02 起注册 BullMQ 消费者和接入状态机。 */
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '@rag/config';
import { HealthModule } from '@rag/health';
import { ObservabilityModule } from '@rag/observability';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { RedisPersistenceModule } from '@rag/persistence-redis';
import { IngestionQueueConsumer } from './ingestion-queue.consumer';

@Module({
  imports: [
    RuntimeConfigModule,
    ObservabilityModule,
    HealthModule,
    PostgresPersistenceModule,
    RedisPersistenceModule,
  ],
  providers: [IngestionQueueConsumer],
})
export class IngestionWorkerModule {}
