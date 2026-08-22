/** 平台管理 API 根模块；后续接入知识空间、文档和任务管理用例。 */
import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '@rag/config';
import { HealthModule } from '@rag/health';
import { ObservabilityModule } from '@rag/observability';
import { M01Module } from './m01/m01.module';
import { M02Module } from './m02/m02.module';
import { M03Module } from './m03/m03.module';
import { M04Module } from './m04/m04.module';
import { M05Module } from './m05/m05.module';

@Module({
  imports: [
    RuntimeConfigModule,
    ObservabilityModule,
    HealthModule,
    M01Module,
    M02Module,
    M03Module,
    M04Module,
    M05Module,
  ],
})
export class PlatformApiModule {}
