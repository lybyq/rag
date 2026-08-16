/** 调度 Worker 根模块；后续承载恢复扫描、定时评测和生命周期任务。 */
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '@rag/config';
import { HealthModule } from '@rag/health';
import { ObservabilityModule } from '@rag/observability';

@Module({
  imports: [RuntimeConfigModule, ObservabilityModule, HealthModule],
})
export class SchedulerWorkerModule {}
