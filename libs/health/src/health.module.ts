/** 健康检查模块负责组装纯契约与四种基础设施 Adapter。 */
import { Module } from '@nestjs/common';
import { MilvusPersistenceModule } from '@rag/persistence-milvus';
import { MinioPersistenceModule } from '@rag/persistence-minio';
import { PostgresPersistenceModule } from '@rag/persistence-pg';
import { RedisPersistenceModule } from '@rag/persistence-redis';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** HTTP 与 Worker 都复用的健康检查组装模块。 */
@Module({
  imports: [
    PostgresPersistenceModule,
    RedisPersistenceModule,
    MinioPersistenceModule,
    MilvusPersistenceModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
