/**
 * M05 离线测试 Embedding Adapter。
 *
 * 它从 SHA-256 确定性生成单位向量，供 test/external-ci 在无公网、无个人密钥时运行。
 * production 和 intranet Profile 已由配置门禁禁止选择 fixture；本实现不能作为质量模型上线。
 *
 * @requirement IDX-001
 * @requirement CFG-002
 * @requirement CFG-003
 */
import { createHash } from 'node:crypto';
import type { EmbeddingPort, ProviderCallOptions } from '@rag/application';
import type { AppConfig } from '@rag/config';
import type {
  EmbeddingBatchResponse,
  EmbeddingInput,
  EmbeddingProviderMetadata,
  EmbeddingPurpose,
  SparseVector,
} from '@rag/contracts';

/** 只用于确定性测试的 Fixture Adapter。 */
export class FixtureEmbeddingAdapter implements EmbeddingPort {
  public constructor(private readonly config: AppConfig) {}

  public checkHealth(options: ProviderCallOptions): Promise<void> {
    throwIfAborted(options.signal);
    return Promise.resolve();
  }

  public getMetadata(options: ProviderCallOptions): Promise<EmbeddingProviderMetadata> {
    throwIfAborted(options.signal);
    return Promise.resolve({
      provider: this.config.embedding.providerName,
      modelId: this.config.embedding.modelId,
      revision: this.config.embedding.revision,
      protocolVersion: this.config.embedding.protocolVersion,
      tokenizerRevision: this.config.embedding.tokenizerRevision,
      denseDimension: this.config.embedding.denseDimension,
      normalizeDense: this.config.embedding.normalizeDense,
      sparseFormatVersion: this.config.embedding.sparseFormatVersion,
      maxInputTokens: this.config.embedding.maxInputTokens,
      maxBatchSize: this.config.embedding.batchSize,
      capabilities: [
        'query',
        'document',
        'dense',
        ...(this.config.embedding.sparseFormatVersion ? (['sparse'] as const) : []),
      ],
    });
  }

  public embedDocuments(
    inputs: readonly EmbeddingInput[],
    options: ProviderCallOptions,
  ): Promise<EmbeddingBatchResponse> {
    return this.embed('DOCUMENT', inputs, options);
  }

  public embedQueries(
    inputs: readonly EmbeddingInput[],
    options: ProviderCallOptions,
  ): Promise<EmbeddingBatchResponse> {
    return this.embed('QUERY', inputs, options);
  }

  private embed(
    purpose: EmbeddingPurpose,
    inputs: readonly EmbeddingInput[],
    options: ProviderCallOptions,
  ): Promise<EmbeddingBatchResponse> {
    throwIfAborted(options.signal);
    return Promise.resolve({
      outputs: inputs.map((input) => ({
        itemId: input.itemId,
        contentSha256: input.contentSha256,
        dense: deterministicUnitVector(
          `${purpose}:${input.contentSha256}`,
          this.config.embedding.denseDimension,
        ),
        sparse: this.config.embedding.sparseFormatVersion
          ? deterministicSparse(input.contentSha256)
          : null,
        modelId: this.config.embedding.modelId,
        revision: this.config.embedding.revision,
      })),
      failures: [],
    });
  }
}

function deterministicUnitVector(seed: string, dimension: number): number[] {
  const digest = createHash('sha256').update(seed).digest();
  const values = Array.from(
    { length: dimension },
    (_, index) => (digest[index % digest.length] ?? 0) / 127.5 - 1,
  );
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

function deterministicSparse(seed: string): SparseVector {
  const digest = createHash('sha256').update(seed).digest();
  const pairs = Array.from({ length: 8 }, (_, index) => ({
    index: ((digest[index] ?? 0) * 257 + index) % 65_536,
    value: ((digest[index + 8] ?? 1) + 1) / 256,
  })).sort((left, right) => left.index - right.index);
  const unique = pairs.filter(
    (item, index) => index === 0 || item.index !== pairs[index - 1]?.index,
  );
  return { indices: unique.map((item) => item.index), values: unique.map((item) => item.value) };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('已取消');
}
