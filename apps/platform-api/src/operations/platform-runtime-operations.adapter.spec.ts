/**
 * Platform 运行状态 Adapter 回归测试。
 *
 * 测试只模拟已完成的健康探针与数据库心跳，不建立真实外部连接；重点验证内部健康结果
 * 转成浏览器公共契约时会归一化小数耗时、补齐可读消息，避免单个字段导致 Dashboard 500。
 *
 * @requirement OPS-005
 */
import type { AppConfig } from '@rag/config';
import type { ServiceHealthData } from '@rag/contracts';
import type { HealthService } from '@rag/health';
import type { Pool } from 'pg';
import { PlatformRuntimeOperationsAdapter } from './platform-runtime-operations.adapter';

const checkedAt = '2026-08-29T00:00:00.000Z';

describe('[OPS-005] PlatformRuntimeOperationsAdapter', () => {
  it('把探针小数耗时和缺失消息归一化为合法 Dashboard 组件', async () => {
    const readiness: ServiceHealthData = {
      service: 'platform-api',
      status: 'down',
      checkedAt,
      uptimeSeconds: 10,
      dependencies: [
        { name: 'postgresql', status: 'up', latencyMs: 1.6 },
        {
          name: 'redis-cache',
          status: 'down',
          latencyMs: 2.4,
          message: 'Redis PING 失败',
        },
      ],
    };
    const health = {
      readiness: jest.fn<Promise<ServiceHealthData>, []>().mockResolvedValue(readiness),
    } as unknown as HealthService;
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool;
    const adapter = new PlatformRuntimeOperationsAdapter(health, {} as AppConfig, pool);

    const components = await adapter.listComponents();

    expect(components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'dependency:postgresql',
          status: 'UP',
          latencyMs: 2,
          message: '依赖协议检查通过',
        }),
        expect.objectContaining({
          key: 'dependency:redis-cache',
          status: 'DOWN',
          latencyMs: 2,
          message: 'Redis PING 失败',
        }),
      ]),
    );
  });

  it('异常耗时和空白失败消息使用安全兜底，不让运维接口返回 500', async () => {
    const readiness: ServiceHealthData = {
      service: 'platform-api',
      status: 'down',
      checkedAt,
      uptimeSeconds: 10,
      dependencies: [
        {
          name: 'milvus',
          status: 'down',
          latencyMs: Number.NaN,
          message: '   ',
        },
      ],
    };
    const health = {
      readiness: jest.fn<Promise<ServiceHealthData>, []>().mockResolvedValue(readiness),
    } as unknown as HealthService;
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool;
    const adapter = new PlatformRuntimeOperationsAdapter(health, {} as AppConfig, pool);

    const components = await adapter.listComponents();

    expect(components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'dependency:milvus',
          status: 'DOWN',
          latencyMs: 0,
          message: '依赖健康检查失败',
        }),
      ]),
    );
  });
});
