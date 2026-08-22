-- M05：恢复生产端幂等唯一键，同时允许空间发生多次合法发布/回滚。
-- 新代码以 Manifest/Policy/Request 等“事件实例”作为 aggregate_id，而不是永远使用 space_id。

-- 兼容本迁移之前短暂写入的重复空间事件：仅对第二条以后追加事件 UUID，保留全部审计历史。
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY aggregate_id, event_type ORDER BY occurred_at, id
  ) AS occurrence
  FROM outbox_events
)
UPDATE outbox_events event
   SET aggregate_id = left(event.aggregate_id || ':' || event.id::text, 300)
  FROM ranked
 WHERE event.id = ranked.id AND ranked.occurrence > 1;

ALTER TABLE outbox_events
  ADD CONSTRAINT uq_outbox_aggregate_event UNIQUE (aggregate_id, event_type);

COMMENT ON CONSTRAINT uq_outbox_aggregate_event ON outbox_events IS
  'aggregate_id 必须标识事件实例（Job/Manifest/PolicyVersion/RebuildRequest），用于生产端重试去重。';
