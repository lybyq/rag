/**
 * M07 查询改写 Provider Composition Root。
 *
 * 只有本模块读取 Adapter 选择；LangGraph 与 Application 永远只注入 QueryRewritePort。
 *
 * @requirement RET-004
 * @requirement CFG-001
 */
import { Module } from '@nestjs/common';
import { QUERY_REWRITE_PORT, type QueryRewritePort } from '@rag/application';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { FixtureQueryRewriteAdapter, HttpQueryRewriteAdapter } from './query-rewrite.adapter';

/** 查询改写网关模块。 */
@Module({
  providers: [
    {
      provide: QUERY_REWRITE_PORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): QueryRewritePort =>
        config.llm.adapter === 'fixture'
          ? new FixtureQueryRewriteAdapter()
          : new HttpQueryRewriteAdapter(config),
    },
  ],
  exports: [QUERY_REWRITE_PORT],
})
export class QueryRewriteGatewayModule {}
