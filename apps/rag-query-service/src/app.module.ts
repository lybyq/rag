/** 在线问答 API 根模块；与管理面隔离，避免后台任务流量影响问答 SLO。 */
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '@rag/config';
import { HealthModule } from '@rag/health';
import { ObservabilityModule } from '@rag/observability';
import { AnswerGenerationModule } from './answer-generation/answer-generation.module';

@Module({
  imports: [RuntimeConfigModule, ObservabilityModule, HealthModule, AnswerGenerationModule],
})
export class RagQueryServiceModule {}
