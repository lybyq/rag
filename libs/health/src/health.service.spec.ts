import type { AppConfig } from '@rag/config';
import type { DependencyHealth } from '@rag/contracts';
import type { MilvusHealthProbe } from '@rag/persistence-milvus';
import type { MinioHealthProbe } from '@rag/persistence-minio';
import type { PostgresHealthProbe } from '@rag/persistence-pg';
import type { RedisBullmqHealthProbe, RedisCacheHealthProbe } from '@rag/persistence-redis';
import { HealthService } from './health.service';

const config = {
  appName: 'health-test',
  dependencyHealthTimeoutMs: 100,
} as AppConfig;

interface ProbeStub {
  name: string;
  check: jest.Mock<Promise<DependencyHealth>, []>;
}

/** 创建没有真实网络连接的探针替身。 */
function probe(name: string, status: 'up' | 'down'): ProbeStub {
  return {
    name,
    check: jest.fn<Promise<DependencyHealth>, []>().mockResolvedValue({
      name,
      status,
      latencyMs: 1,
    }),
  };
}

describe('HealthService', () => {
  it('liveness 不检查外部依赖', () => {
    const postgresql = probe('postgresql', 'down');
    const service = new HealthService(
      config,
      postgresql as unknown as PostgresHealthProbe,
      probe('redis-cache', 'up') as unknown as RedisCacheHealthProbe,
      probe('redis-bullmq', 'up') as unknown as RedisBullmqHealthProbe,
      probe('minio', 'up') as unknown as MinioHealthProbe,
      probe('milvus', 'up') as unknown as MilvusHealthProbe,
    );

    expect(service.liveness().status).toBe('up');
    expect(postgresql.check).not.toHaveBeenCalled();
  });

  it('任何关键依赖失败都会使 readiness 为 down', async () => {
    const service = new HealthService(
      config,
      probe('postgresql', 'up') as unknown as PostgresHealthProbe,
      probe('redis-cache', 'up') as unknown as RedisCacheHealthProbe,
      probe('redis-bullmq', 'down') as unknown as RedisBullmqHealthProbe,
      probe('minio', 'up') as unknown as MinioHealthProbe,
      probe('milvus', 'up') as unknown as MilvusHealthProbe,
    );

    const result = await service.readiness();
    expect(result.status).toBe('down');
    expect(result.dependencies).toHaveLength(5);
  });
});
