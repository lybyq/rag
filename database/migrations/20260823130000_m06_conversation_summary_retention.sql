-- M06 增量：有限会话记忆也属于敏感派生内容，必须进入同一保留期清理机制。

ALTER TABLE conversation_states
  ADD COLUMN summary_retention_expires_at timestamptz;

CREATE INDEX idx_conversation_states_summary_retention
  ON conversation_states (summary_retention_expires_at)
  WHERE summary_storage IS NOT NULL;

