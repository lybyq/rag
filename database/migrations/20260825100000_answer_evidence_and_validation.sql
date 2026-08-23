-- 证据、生成与答案校验：可信执行身份快照、引用事实、校验报告和结构化反馈。
-- 正文只保留最小引用摘录；完整答案仍受 conversation_messages 的加密与保留策略约束。

ALTER TABLE rag_runs
  ADD COLUMN execution_roles text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN execution_authz_version bigint NOT NULL DEFAULT 0 CHECK (execution_authz_version >= 0),
  ADD COLUMN execution_lease_owner varchar(128),
  ADD COLUMN execution_lease_expires_at timestamptz,
  ADD COLUMN execution_attempts integer NOT NULL DEFAULT 0 CHECK (execution_attempts >= 0);

CREATE INDEX idx_rag_runs_answer_execution
  ON rag_runs (created_at, id)
  WHERE status = 'ACCEPTED';

ALTER TABLE message_feedback
  ADD COLUMN error_types text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN comment varchar(1000);

ALTER TABLE message_feedback
  ADD CONSTRAINT message_feedback_error_types_check CHECK (
    error_types <@ ARRAY[
      'UNSUPPORTED_CLAIM', 'WRONG_CITATION', 'OUTDATED_SOURCE', 'ACCESS_ERROR',
      'CALCULATION_ERROR', 'INCOMPLETE_ANSWER', 'OTHER'
    ]::text[]
  );

-- sourceId 是面向用户和模型的不透明 UUID；真实资源主键只在服务端持久化和复核。
CREATE TABLE answer_citations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES rag_runs(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  manifest_id uuid NOT NULL REFERENCES space_manifests(id),
  space_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  content_revision integer NOT NULL CHECK (content_revision > 0),
  chunk_id varchar(180) NOT NULL REFERENCES knowledge_chunks(id),
  relation varchar(20) NOT NULL CHECK (
    relation IN ('SELF','PARENT','PREVIOUS','NEXT','TABLE_HEADER')
  ),
  authority varchar(20) NOT NULL CHECK (
    authority IN ('POLICY','PROCEDURE','GUIDANCE','REFERENCE','UNKNOWN')
  ),
  title varchar(240) NOT NULL,
  heading_path jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(heading_path) = 'array'),
  excerpt text NOT NULL CHECK (length(excerpt) BETWEEN 1 AND 2000),
  source_locations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_locations) = 'array'),
  published_at timestamptz NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, id)
);

CREATE INDEX idx_answer_citations_message ON answer_citations (message_id, created_at);
CREATE INDEX idx_answer_citations_source_recheck
  ON answer_citations (space_id, document_id, document_version_id, content_revision);

-- 报告记录路由、证据摘要、Validator 与模型 revision，供反馈定位和离线评测重放。
CREATE TABLE answer_validation_reports (
  run_id uuid PRIMARY KEY REFERENCES rag_runs(id) ON DELETE CASCADE,
  message_id uuid NOT NULL UNIQUE REFERENCES conversation_messages(id) ON DELETE CASCADE,
  bundle_sha256 char(64) NOT NULL CHECK (bundle_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_route varchar(24) NOT NULL CHECK (
    evidence_route IN (
      'ANSWER','LLM_RERANK','REWRITE_AND_RETRY','CLARIFY','CONFLICT','PARTIAL_ANSWER','REJECT'
    )
  ),
  final_status varchar(20) NOT NULL CHECK (
    final_status IN ('ANSWERED','PARTIAL','CLARIFICATION','CONFLICT','REJECTED')
  ),
  validation_report jsonb NOT NULL CHECK (jsonb_typeof(validation_report) = 'object'),
  reranker_model_id varchar(160),
  reranker_revision varchar(100),
  llm_model_id varchar(160),
  llm_revision varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_answer_reranker_identity CHECK (
    (reranker_model_id IS NULL AND reranker_revision IS NULL)
    OR (reranker_model_id IS NOT NULL AND reranker_revision IS NOT NULL)
  ),
  CONSTRAINT ck_answer_llm_identity CHECK (
    (llm_model_id IS NULL AND llm_revision IS NULL)
    OR (llm_model_id IS NOT NULL AND llm_revision IS NOT NULL)
  )
);
