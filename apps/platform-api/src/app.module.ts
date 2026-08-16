/** 平台管理 API 根模块；后续接入知识空间、文档和任务管理用例。 */
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '@rag/config';
import { HealthModule } from '@rag/health';
import { ObservabilityModule } from '@rag/observability';

@Module({
  imports: [RuntimeConfigModule, ObservabilityModule, HealthModule],
})
export class PlatformApiModule {}
