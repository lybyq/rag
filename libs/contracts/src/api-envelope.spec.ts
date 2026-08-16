import { ApiErrorSchema, createApiEnvelopeSchema } from './api-envelope';
import { z } from 'zod';

describe('[BASE-006][BASE-007] API runtime contracts', () => {
  it('合法成功信封可以通过运行时校验', () => {
    const schema = createApiEnvelopeSchema(z.object({ value: z.number() }));

    expect(schema.parse({ requestId: 'req-1', data: { value: 42 } })).toEqual({
      requestId: 'req-1',
      data: { value: 42 },
    });
  });

  it('缺少稳定错误字段时拒绝非法响应', () => {
    const result = ApiErrorSchema.safeParse({
      requestId: 'req-1',
      code: 'INTERNAL_ERROR',
      message: '系统暂时不可用',
    });

    expect(result.success).toBe(false);
  });
});
