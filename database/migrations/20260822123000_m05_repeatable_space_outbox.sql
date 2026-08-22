-- M05：空间发布、撤权和回滚会重复发生，旧的 aggregate_id + event_type 唯一键会阻止第二次合法事件。
-- 每次业务事务已经拥有唯一的 Run/Manifest/Policy 版本聚合键，因此移除这个过粗的历史约束。
-- Outbox 自身 UUID、业务事务和消费者收据继续分别保证生产端原子性与消费端幂等性。

ALTER TABLE outbox_events
  DROP CONSTRAINT uq_outbox_aggregate_event;

CREATE INDEX idx_outbox_aggregate_history
  ON outbox_events (aggregate_type, aggregate_id, occurred_at DESC);

COMMENT ON INDEX idx_outbox_aggregate_history IS
  '用于审计同一业务聚合的重复发布/回滚/撤权历史；不禁止合法的后续事件。';
