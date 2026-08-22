/**
 * M05 Embedding Adapter Composition Root。
 * 只有本模块读取已校验 AppConfig 选择 Adapter；Application 和业务 Controller 不包含环境分支。
 *
 * @requirement CFG-001
 * @requirement CFG-006
 */
import { Module } from '@nestjs/common';
import { EMBEDDING_PORT, type EmbeddingPort } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { FixtureEmbeddingAdapter } from './fixture-embedding.adapter';
import { HttpEmbeddingAdapter } from './http-embedding.adapter';

/** 为 Worker 和后续 Query Service 导出统一 EmbeddingPort。 */
@Module({
  providers: [
    {
      provide: EMBEDDING_PORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): EmbeddingPort => {
        if (config.embedding.adapter === 'fixture') return new FixtureEmbeddingAdapter(config);
        // 内网 `http` 和通用兼容入口共享项目自有 v1 契约；供应商协议不同时新增 Adapter。
        return new HttpEmbeddingAdapter(config);
      },
    },
  ],
  exports: [EMBEDDING_PORT],
})
export class EmbeddingGatewayModule {}
