-- M06：会话、消息、Run/Step、幂等创建、事件 Outbox、反馈与合规保留期。
-- PostgreSQL 保存不可丢失的业务事实；Redis Stream 是带 TTL 的顺序事件投影。

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id varchar(128) NOT NULL,
  title varchar(200) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  optimistic_version bigint NOT NULL DEFAULT 0 CHECK (optimistic_version >= 0),
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_owner_recent
  ON conversations (owner_user_id, updated_at DESC, id DESC);

CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id uuid,
  role varchar(16) NOT NULL CHECK (role IN ('USER', 'ASSISTANT', 'SYSTEM')),
  status varchar(16) NOT NULL CHECK (status IN ('PENDING', 'VISIBLE', 'REDACTED', 'DELETED')),
  content_storage varchar(20) NOT NULL CHECK (content_storage IN ('AES_256_GCM', 'REDACTED', 'PLAIN')),
  content_value text NOT NULL,
  content_iv varchar(64),
  content_auth_tag varchar(64),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  citations_summary jsonb,
  retention_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_encryption_shape CHECK (
    (content_storage = 'AES_256_GCM' AND content_iv IS NOT NULL AND content_auth_tag IS NOT NULL)
    OR (content_storage <> 'AES_256_GCM' AND content_iv IS NULL AND content_auth_tag IS NULL)
  )
);

CREATE INDEX idx_conversation_messages_window
  ON conversation_messages (conversation_id, created_at DESC, id DESC);
CREATE INDEX idx_conversation_messages_retention
  ON conversation_messages (retention_expires_at)
  WHERE status NOT IN ('REDACTED', 'DELETED');

CREATE TABLE conversation_states (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary_storage varchar(20) CHECK (summary_storage IN ('AES_256_GCM', 'REDACTED', 'PLAIN')),
  summary_value text,
  summary_iv varchar(64),
  summary_auth_tag varchar(64),
  confirmed_entities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(confirmed_entities) = 'array'),
  recent_citation_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  short_window_message_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_state_summary_shape CHECK (
    (summary_storage IS NULL AND summary_value IS NULL AND summary_iv IS NULL AND summary_auth_tag IS NULL)
    OR (summary_storage = 'AES_256_GCM' AND summary_value IS NOT NULL AND summary_iv IS NOT NULL AND summary_auth_tag IS NOT NULL)
    OR (summary_storage IN ('REDACTED', 'PLAIN') AND summary_value IS NOT NULL AND summary_iv IS NULL AND summary_auth_tag IS NULL)
  )
);

CREATE TABLE rag_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  owner_user_id varchar(128) NOT NULL,
  user_message_id uuid NOT NULL REFERENCES conversation_messages(id),
  assistant_message_id uuid REFERENCES conversation_messages(id),
  idempotency_key varchar(200) NOT NULL,
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  status varchar(16) NOT NULL DEFAULT 'ACCEPTED' CHECK (
    status IN ('ACCEPTED', 'RUNNING', 'CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')
  ),
  optimistic_version bigint NOT NULL DEFAULT 0 CHECK (optimistic_version >= 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  deadline_at timestamptz NOT NULL,
  event_expires_at timestamptz NOT NULL,
  cancel_requested_at timestamptz,
  cancellation_reason varchar(500),
  failure_code varchar(100),
  public_message varchar(500) NOT NULL,
  answer_sha256 char(64) CHECK (answer_sha256 IS NULL OR answer_sha256 ~ '^[a-f0-9]{64}$'),
  next_event_sequence bigint NOT NULL DEFAULT 0 CHECK (next_event_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, idempotency_key),
  UNIQUE (assistant_message_id)
);

ALTER TABLE conversation_messages
  ADD CONSTRAINT conversation_messages_run_fk
  FOREIGN KEY (run_id) REFERENCES rag_runs(id) ON DELETE SET NULL;

CREATE INDEX idx_rag_runs_owner_recent ON rag_runs (owner_user_id, created_at DESC, id DESC);
CREATE INDEX idx_rag_runs_expiry ON rag_runs (deadline_at)
  WHERE status IN ('ACCEPTED', 'RUNNING', 'CANCELLING');

CREATE TABLE rag_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES rag_runs(id) ON DELETE CASCADE,
  node_key varchar(100) NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status varchar(16) NOT NULL CHECK (
    status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED')
  ),
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_summary) = 'object'),
  output_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(output_summary) = 'object'),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code varchar(100),
  error_message varchar(500),
  trace_id varchar(64),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, node_key, attempt)
);

CREATE INDEX idx_rag_run_steps_run ON rag_run_steps (run_id, created_at, id);

CREATE TABLE rag_run_event_outbox (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES rag_runs(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  event_type varchar(100) NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by varchar(128),
  locked_until timestamptz,
  published_at timestamptz,
  last_error_code varchar(100),
  UNIQUE (run_id, sequence)
);

CREATE INDEX idx_rag_run_event_outbox_pending
  ON rag_run_event_outbox (available_at, occurred_at)
  WHERE published_at IS NULL;

CREATE TABLE message_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  owner_user_id varchar(128) NOT NULL,
  rating varchar(20) NOT NULL CHECK (rating IN ('HELPFUL', 'NOT_HELPFUL')),
  reason varchar(1000),
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, owner_user_id)
);
