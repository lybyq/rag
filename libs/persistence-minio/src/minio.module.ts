/** MinIO Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import { MinioHealthProbe } from './minio-health.probe';

/** 当前只注册 M00 的就绪探针。 */
@Module({ providers: [MinioHealthProbe], exports: [MinioHealthProbe] })
export class MinioPersistenceModule {}
