/**
 * 把配置文件中的答案开关注册为数据库 Feature Flag 初始事实。
 *
 * 只在 key 不存在时插入，后续运维修改不会被进程重启覆盖；这让不同内外网 Profile 拥有
 * 各自安全默认值，同时保留数据库灰度和回退能力。
 *
 * @requirement OPS-016
 */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from './postgres.tokens';

/** Feature Flag 默认值 Seeder。 */
@Injectable()
export class PostgresFeatureFlagSeeder implements OnModuleInit {
  public constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  public async onModuleInit(): Promise<void> {
    const flags = [
      ['ANSWER_LLM_EVIDENCE_RERANK_ENABLED', this.config.answer.llmEvidenceRerankEnabled],
      ['ANSWER_SEMANTIC_JUDGE_ENABLED', this.config.answer.semanticJudgeEnabled],
      ['ANSWER_RERANK_FALLBACK_ENABLED', this.config.answer.rerankFallbackEnabled],
      ['ANSWER_STRICT_STREAMING', this.config.answer.strictStreaming],
    ] as const;
    for (const [key, enabled] of flags) {
      await this.pool
        .query(
          `INSERT INTO feature_flags (
             flag_key,scope,space_id,enabled,rollout_percent,reason,updated_by
           ) VALUES ($1,'SYSTEM',NULL,$2,100,'由环境 Profile 注册的初始安全值','system-bootstrap')
           ON CONFLICT (flag_key) WHERE scope='SYSTEM' DO NOTHING`,
          [key, enabled],
        )
        .catch(() => undefined);
    }
  }
}
