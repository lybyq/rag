/**
 * Ingestion BullMQ 事件路由回归测试。
 *
 * 该测试确保命令事件才进入耗时阶段，而取消通知只进入生命周期收据分支，避免合法取消事件
 * 成为重试五次的死信。它不启动真实 Worker，也不测试 PostgreSQL/BullMQ Adapter。
 *
 * @requirement DOC-009
 */
import { classifyIngestionQueueStage } from './ingestion-queue.consumer';

describe('[DOC-009] Ingestion Queue 事件路由', () => {
  it.each([
    ['ingestion.requested', 'DOCUMENT_PARSING'],
    ['ingestion.knowledge_processing.requested', 'KNOWLEDGE_PROCESSING'],
    ['ingestion.indexing.requested', 'INDEXING_PUBLICATION'],
    ['ingestion.cancelled', 'LIFECYCLE'],
    ['index.published', 'PROJECTION'],
    ['cache.invalidate.space', 'PROJECTION'],
  ] as const)('%s -> %s', (eventType, expected) => {
    expect(classifyIngestionQueueStage(eventType)).toBe(expected);
  });

  it('未知事件保持失败，禁止被误路由为文档处理命令', () => {
    expect(() => classifyIngestionQueueStage('ingestion.unknown')).toThrow(/不支持/);
  });
});
