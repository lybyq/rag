import { z } from 'zod';
import { createEventEnvelopeSchema } from './event-envelope';

describe('版本化事件信封', () => {
  const Schema = createEventEnvelopeSchema(z.object({ documentId: z.string().min(1) }));

  it('接受具有幂等 ID、版本和时间的事件', () => {
    expect(
      Schema.parse({
        eventId: 'e7be8dfb-0af3-4f25-97e9-3b23153eb9bb',
        eventType: 'document.accepted',
        eventVersion: 1,
        occurredAt: '2026-08-15T08:00:00.000Z',
        producer: 'platform-api',
        data: { documentId: 'doc-001' },
      }),
    ).toEqual(expect.objectContaining({ eventVersion: 1 }));
  });

  it('拒绝无版本或无效 UUID 的事件', () => {
    expect(() =>
      Schema.parse({
        eventId: 'not-a-uuid',
        eventType: 'document.accepted',
        occurredAt: '2026-08-15T08:00:00.000Z',
        producer: 'platform-api',
        data: { documentId: 'doc-001' },
      }),
    ).toThrow();
  });
});
