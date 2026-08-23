/** @requirement OPS-007 Redis 流控 Lua 的静态安全边界测试。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('RedisTrafficControlAdapter', () => {
  it('清理过期并发租约、支持幂等释放且不使用离线队列 Redis', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'libs/persistence-redis/src/redis-traffic-control.adapter.ts'),
      'utf8',
    );
    expect(source).toContain('ZREMRANGEBYSCORE');
    expect(source).toContain('if not activeKey then return 0 end');
    expect(source).toContain('config.redisCacheUrl');
    expect(source).not.toContain('config.redisBullmqUrl');
  });
});
