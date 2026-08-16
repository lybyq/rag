/**
 * 聚合四类外部依赖的协议级探针，并把超时转换为稳定、脱敏的健康结果。
 * Liveness 不访问外部依赖；Readiness 才用于阻止流量进入不完整实例。
 *
 * @requirement BASE-009
 */
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import type { DependencyHealth, HealthProbe, ServiceHealthData } from '@rag/contracts';
import { MilvusHealthProbe } from '@rag/persistence-milvus';
import { MinioHealthProbe } from '@rag/persistence-minio';
import { PostgresHealthProbe } from '@rag/persistence-pg';
import { RedisBullmqHealthProbe, RedisCacheHealthProbe } from '@rag/persistence-redis';

/** 超时后返回统一的 down 结果，而不是把底层连接字符串或堆栈暴露给客户端。 */
async function checkWithTimeout(probe: HealthProbe, timeoutMs: number): Promise<DependencyHealth> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DependencyHealth>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          name: probe.name,
          status: 'down',
          latencyMs: timeoutMs,
          message: '依赖健康检查超时',
        }),
      timeoutMs,
    );
    timer.unref();
  });

  try {
    return await Promise.race([probe.check(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 应用统一健康聚合服务。 */
@Injectable()
export class HealthService {
  private readonly probes: readonly HealthProbe[];

  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PostgresHealthProbe) postgres: PostgresHealthProbe,
    @Inject(RedisCacheHealthProbe) redisCache: RedisCacheHealthProbe,
    @Inject(RedisBullmqHealthProbe) redisBullmq: RedisBullmqHealthProbe,
    @Inject(MinioHealthProbe) minio: MinioHealthProbe,
    @Inject(MilvusHealthProbe) milvus: MilvusHealthProbe,
  ) {
    this.probes = [postgres, redisCache, redisBullmq, minio, milvus];
  }

  /** 仅证明 Node/Nest 事件循环仍能响应。 */
  public liveness(): ServiceHealthData {
    return {
      service: this.config.appName,
      status: 'up',
      checkedAt: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      dependencies: [],
    };
  }

  /** 并行检查全部关键依赖；任何一项失败都会使实例不接收正式流量。 */
  public async readiness(): Promise<ServiceHealthData> {
    const dependencies = await Promise.all(
      this.probes.map((probe) => checkWithTimeout(probe, this.config.dependencyHealthTimeoutMs)),
    );
    const ready = dependencies.every((dependency) => dependency.status === 'up');

    return {
      service: this.config.appName,
      status: ready ? 'up' : 'down',
      checkedAt: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      dependencies,
    };
  }
}
