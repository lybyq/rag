/**
 * M05 Embedding 启动兼容性门禁。
 * Worker 开始消费任务前真实读取 Provider `/health` 与 `/metadata`；不匹配时拒绝启动，避免污染 Collection。
 *
 * @requirement IDX-003
 */
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { IndexingService } from '@rag/application';

/** Nest 生命周期门禁；Fixture 也走同一契约，不为测试写业务分支。 */
@Injectable()
export class EmbeddingStartupVerifier implements OnApplicationBootstrap {
  public constructor(@Inject(IndexingService) private readonly indexing: IndexingService) {}

  public async onApplicationBootstrap(): Promise<void> {
    await this.indexing.verifyProviderCompatibility();
  }
}
