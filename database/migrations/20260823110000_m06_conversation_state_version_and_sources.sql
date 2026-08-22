-- M06 增量：会话摘要乐观锁与来源空间反查。
-- 迁移已部署环境只能前滚；不修改上一条已执行迁移，避免数据库与代码基线分叉。

ALTER TABLE conversation_states
  ADD COLUMN optimistic_version bigint NOT NULL DEFAULT 0 CHECK (optimistic_version >= 0),
  ADD COLUMN summary_source_space_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];

