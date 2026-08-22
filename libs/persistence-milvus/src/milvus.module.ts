/** Milvus Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import { VECTOR_INDEX_PORT, type VectorIndexPort } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { MilvusHealthProbe } from './milvus-health.probe';
import { MemoryVectorIndexAdapter } from './memory-vector-index.adapter';
import { MilvusVectorIndexAdapter } from './milvus-vector-index.adapter';

/** 健康探针始终可用；业务 Vector Port 由白名单配置选择。 */
@Module({
  providers: [
    MilvusHealthProbe,
    {
      provide: VECTOR_INDEX_PORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): VectorIndexPort =>
        config.vectorStore.adapter === 'memory'
          ? new MemoryVectorIndexAdapter()
          : new MilvusVectorIndexAdapter(config),
    },
  ],
  exports: [MilvusHealthProbe, VECTOR_INDEX_PORT],
})
export class MilvusPersistenceModule {}
