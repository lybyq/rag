/** MinIO Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import { OBJECT_STORAGE, type ObjectStoragePort } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { MinioHealthProbe } from './minio-health.probe';
import { MinioObjectStorageAdapter } from './minio-object-storage.adapter';

/** 同时提供健康探针和 M02 对象存储端口。 */
@Module({
  providers: [
    MinioHealthProbe,
    {
      provide: OBJECT_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): ObjectStoragePort => new MinioObjectStorageAdapter(config),
    },
  ],
  exports: [MinioHealthProbe, OBJECT_STORAGE],
})
export class MinioPersistenceModule {}
