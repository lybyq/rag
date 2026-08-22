/** 调度 Worker 根模块；后续承载恢复扫描、定时评测和生命周期任务。 */
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '@rag/config';
import { HealthModule } from '@rag/health';
import { ObservabilityModule } from '@rag/observability';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { MilvusPersistenceModule } from '@rag/persistence-milvus';
import { MinioPersistenceModule } from '@rag/persistence-minio';
import { RedisPersistenceModule } from '@rag/persistence-redis';
import { IngestionMaintenanceScheduler } from './ingestion-maintenance.scheduler';
import { IndexMaintenanceScheduler } from './index-maintenance.scheduler';
import { ProfileRolloutScheduler } from './profile-rollout.scheduler';
import { EmbeddingGatewayModule } from '@rag/model-gateway';

@Module({
  imports: [
    RuntimeConfigModule,
    ObservabilityModule,
    HealthModule,
    PostgresPersistenceModule,
    RedisPersistenceModule,
    MilvusPersistenceModule,
    MinioPersistenceModule,
    EmbeddingGatewayModule,
  ],
  providers: [IngestionMaintenanceScheduler, IndexMaintenanceScheduler, ProfileRolloutScheduler],
})
export class SchedulerWorkerModule {}
