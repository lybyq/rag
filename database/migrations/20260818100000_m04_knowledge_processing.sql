-- M04：结构感知 Chunk、关系、质量报告、人工审核与 content revision 保留。
-- PostgreSQL 是审核和索引资格的事实源；Milvus 在 M05 只消费 eligible_for_index=true 的投影。

ALTER TABLE protected_resource_spaces
  DROP CONSTRAINT protected_resource_spaces_resource_type_check;

ALTER TABLE protected_resource_spaces
  ADD CONSTRAINT protected_resource_spaces_resource_type_check CHECK (
    resource_type IN (
      'DOCUMENT', 'KNOWLEDGE_RUN', 'CITATION', 'HISTORY_MESSAGE',
      'RETRIEVAL_CANDIDATE', 'EXPORT'
    )
  );

CREATE TABLE knowledge_processing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id varchar(300) NOT NULL REFERENCES ingestion_jobs(id),
  parse_run_id uuid NOT NULL REFERENCES document_parse_runs(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  content_revision integer NOT NULL CHECK (content_revision >= 1),
  file_format varchar(16) NOT NULL CHECK (
    file_format IN ('PDF', 'DOCX', 'XLSX', 'PPTX', 'IMAGE', 'HTML', 'MARKDOWN', 'TEXT', 'CSV')
  ),
  status varchar(16) NOT NULL CHECK (
    status IN ('RUNNING', 'SUCCEEDED', 'WAITING', 'FAILED', 'REJECTED')
  ),
  chunker_profile_id varchar(100) NOT NULL,
  chunker_revision varchar(100) NOT NULL,
  tokenizer_profile_id varchar(100) NOT NULL,
  tokenizer_revision varchar(100) NOT NULL,
  quality_rule_version varchar(100) NOT NULL,
  parent_chunk_count integer NOT NULL DEFAULT 0 CHECK (parent_chunk_count >= 0),
  child_chunk_count integer NOT NULL DEFAULT 0 CHECK (child_chunk_count >= 0),
  relation_count integer NOT NULL DEFAULT 0 CHECK (relation_count >= 0),
  failure_code varchar(100),
  failure_message varchar(500),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_knowledge_processing_job UNIQUE (job_id),
  CONSTRAINT uq_knowledge_processing_parse_run UNIQUE (parse_run_id)
);

CREATE INDEX idx_knowledge_runs_version_revision
  ON knowledge_processing_runs (document_version_id, content_revision DESC, created_at DESC);
CREATE INDEX idx_knowledge_runs_status_updated
  ON knowledge_processing_runs (status, updated_at DESC);

CREATE TABLE knowledge_chunks (
  id varchar(180) PRIMARY KEY,
  processing_run_id uuid NOT NULL REFERENCES knowledge_processing_runs(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  content_revision integer NOT NULL CHECK (content_revision >= 1),
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  granularity varchar(12) NOT NULL CHECK (granularity IN ('PARENT', 'CHILD')),
  content_type varchar(16) NOT NULL CHECK (
    content_type IN ('PROSE', 'LIST', 'TABLE', 'CODE', 'FAQ', 'CLAUSE', 'SLIDE', 'SHEET')
  ),
  display_content text NOT NULL CHECK (length(display_content) > 0),
  embedding_text text NOT NULL CHECK (length(embedding_text) > 0),
  token_count integer NOT NULL CHECK (token_count > 0),
  tokenizer_profile_id varchar(100) NOT NULL,
  tokenizer_revision varchar(100) NOT NULL,
  heading_path jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(heading_path) = 'array'),
  source_locations jsonb NOT NULL CHECK (jsonb_typeof(source_locations) = 'array'),
  parent_chunk_id varchar(180),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  dedup_status varchar(32) NOT NULL CHECK (
    dedup_status IN ('UNIQUE', 'RETAINED_DUPLICATE', 'SUPPRESSED_DUPLICATE')
  ),
  duplicate_of_chunk_id varchar(180),
  eligible_for_index boolean NOT NULL DEFAULT false,
  split_reason varchar(100),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_knowledge_chunk_ordinal UNIQUE (processing_run_id, ordinal),
  CONSTRAINT fk_knowledge_chunk_parent FOREIGN KEY (parent_chunk_id) REFERENCES knowledge_chunks(id),
  CONSTRAINT fk_knowledge_chunk_duplicate FOREIGN KEY (duplicate_of_chunk_id) REFERENCES knowledge_chunks(id),
  CONSTRAINT ck_knowledge_chunk_parent CHECK (
    (granularity = 'PARENT' AND parent_chunk_id IS NULL)
    OR (granularity = 'CHILD' AND parent_chunk_id IS NOT NULL)
  ),
  CONSTRAINT ck_knowledge_chunk_duplicate CHECK (
    (dedup_status = 'UNIQUE' AND duplicate_of_chunk_id IS NULL)
    OR (dedup_status <> 'UNIQUE' AND duplicate_of_chunk_id IS NOT NULL)
  )
);

CREATE INDEX idx_knowledge_chunks_run_ordinal ON knowledge_chunks (processing_run_id, ordinal);
CREATE INDEX idx_knowledge_chunks_parent ON knowledge_chunks (parent_chunk_id)
  WHERE parent_chunk_id IS NOT NULL;
CREATE INDEX idx_knowledge_chunks_index_eligible
  ON knowledge_chunks (document_version_id, content_revision, ordinal)
  WHERE eligible_for_index = true;
CREATE INDEX idx_knowledge_chunks_content_hash ON knowledge_chunks (content_sha256);

CREATE TABLE chunk_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_run_id uuid NOT NULL REFERENCES knowledge_processing_runs(id),
  from_chunk_id varchar(180) NOT NULL REFERENCES knowledge_chunks(id),
  relation_type varchar(24) NOT NULL CHECK (
    relation_type IN (
      'PARENT_CHILD', 'PREVIOUS', 'NEXT', 'SOURCE_BLOCK',
      'TABLE_HEADER', 'FOOTNOTE', 'DUPLICATE_OF'
    )
  ),
  to_chunk_id varchar(180) REFERENCES knowledge_chunks(id),
  to_block_id varchar(160) REFERENCES document_blocks(id),
  ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_chunk_relation_target CHECK (
    (to_chunk_id IS NOT NULL AND to_block_id IS NULL)
    OR (to_chunk_id IS NULL AND to_block_id IS NOT NULL)
  ),
  CONSTRAINT uq_chunk_relation UNIQUE (
    from_chunk_id, relation_type, to_chunk_id, to_block_id, ordinal
  )
);

CREATE INDEX idx_chunk_relations_from ON chunk_relations (from_chunk_id, relation_type, ordinal);
CREATE INDEX idx_chunk_relations_to_chunk ON chunk_relations (to_chunk_id)
  WHERE to_chunk_id IS NOT NULL;
CREATE INDEX idx_chunk_relations_to_block ON chunk_relations (to_block_id)
  WHERE to_block_id IS NOT NULL;

CREATE TABLE document_quality_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_run_id uuid NOT NULL REFERENCES knowledge_processing_runs(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  content_revision integer NOT NULL CHECK (content_revision >= 1),
  verdict varchar(20) NOT NULL CHECK (verdict IN ('PASS', 'MANUAL_REVIEW', 'REJECT')),
  rule_version varchar(100) NOT NULL,
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  review_decision varchar(24) NOT NULL CHECK (
    review_decision IN ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED', 'REPROCESS_REQUESTED')
  ),
  review_reason varchar(500),
  reviewed_by varchar(128),
  reviewed_at timestamptz,
  optimistic_version integer NOT NULL DEFAULT 1 CHECK (optimistic_version >= 1),
  eligible_for_index boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_document_quality_processing_run UNIQUE (processing_run_id)
);

CREATE INDEX idx_quality_reports_version_revision
  ON document_quality_reports (document_version_id, content_revision DESC);
CREATE INDEX idx_quality_reports_review
  ON document_quality_reports (review_decision, updated_at DESC)
  WHERE review_decision = 'PENDING';

CREATE TABLE document_quality_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES document_quality_reports(id),
  severity varchar(12) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'ERROR')),
  code varchar(100) NOT NULL,
  message varchar(500) NOT NULL,
  page_nos jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(page_nos) = 'array'),
  block_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(block_ids) = 'array'),
  chunk_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(chunk_ids) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_quality_findings_report
  ON document_quality_findings (report_id, severity, created_at);

-- 审核历史不可变；当前结论位于 report，完整行为轨迹位于本表和通用 audit_logs。
CREATE TABLE knowledge_quality_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES document_quality_reports(id),
  action varchar(24) NOT NULL CHECK (action IN ('APPROVE', 'REJECT', 'REQUEST_REPROCESS')),
  previous_decision varchar(24) NOT NULL,
  resulting_decision varchar(24) NOT NULL,
  reason varchar(500) NOT NULL,
  actor_user_id varchar(128) NOT NULL,
  actor_roles text[] NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 1),
  resulting_version integer NOT NULL CHECK (resulting_version >= 2),
  request_id varchar(128) NOT NULL,
  trace_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_quality_reviews_report_created
  ON knowledge_quality_reviews (report_id, created_at DESC);
