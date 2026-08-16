/** 调度 Worker 根模块；后续承载恢复扫描、定时评测和生命周期任务。 */
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '@rag/config';
import { HealthModule } from '@rag/health';
import { ObservabilityModule } from '@rag/observability';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { RedisPersistenceModule } from '@rag/persistence-redis';
import { IngestionMaintenanceScheduler } from './ingestion-maintenance.scheduler';

@Module({
  imports: [
    RuntimeConfigModule,
    ObservabilityModule,
    HealthModule,
    PostgresPersistenceModule,
    RedisPersistenceModule,
  ],
  providers: [IngestionMaintenanceScheduler],
})
export class SchedulerWorkerModule {}
