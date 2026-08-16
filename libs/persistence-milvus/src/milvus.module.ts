/** Milvus Adapter 的 NestJS 组装模块。 */
import { Module } from '@nestjs/common';
import { MilvusHealthProbe } from './milvus-health.probe';

/** 当前只注册 M00 所需的 Milvus 就绪探针。 */
@Module({ providers: [MilvusHealthProbe], exports: [MilvusHealthProbe] })
export class MilvusPersistenceModule {}
