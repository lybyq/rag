import { loadAppConfig } from '@rag/config';
import type { HealthProbe } from '@rag/contracts';
import { MilvusHealthProbe } from '@rag/persistence-milvus';
import { MinioHealthProbe } from '@rag/persistence-minio';
import { PostgresHealthProbe } from '@rag/persistence-pg';
import { RedisBullmqHealthProbe, RedisCacheHealthProbe } from '@rag/persistence-redis';

const describeWithInfra = process.env.RUN_INTEGRATION_TESTS === 'true' ? describe : describe.skip;

describeWithInfra('M00 本地基础设施契约', () => {
  it('PostgreSQL、两类 Redis、MinIO、Milvus 都通过真实协议检查', async () => {
    const config = loadAppConfig(process.env);
    const probes: HealthProbe[] = [
      new PostgresHealthProbe(config),
      new RedisCacheHealthProbe(config),
      new RedisBullmqHealthProbe(config),
      new MinioHealthProbe(config),
      new MilvusHealthProbe(config),
    ];

    const results = await Promise.all(probes.map((probe) => probe.check()));
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'postgresql', status: 'up' }),
        expect.objectContaining({ name: 'redis-cache', status: 'up' }),
        expect.objectContaining({ name: 'redis-bullmq', status: 'up' }),
        expect.objectContaining({ name: 'minio', status: 'up' }),
        expect.objectContaining({ name: 'milvus', status: 'up' }),
      ]),
    );

    await Promise.all(
      probes.map(async (probe) => {
        if ('onModuleDestroy' in probe && typeof probe.onModuleDestroy === 'function') {
          await probe.onModuleDestroy();
        }
      }),
    );
  });
});
