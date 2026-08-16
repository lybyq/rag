-- M02：文档接入、直传会话、入库任务、步骤进度、事件与事务 Outbox。
-- 原始文件字节只进入对象存储；本迁移只保存可审计事实和随机对象路径。

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  title varchar(240) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  latest_version_number integer NOT NULL DEFAULT 1 CHECK (latest_version_number >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_documents_space_updated ON documents (space_id, updated_at DESC, id DESC);
CREATE INDEX idx_documents_status_updated ON documents (status, updated_at DESC, id DESC);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id),
  version_number integer NOT NULL CHECK (version_number >= 1),
  content_revision integer NOT NULL DEFAULT 1 CHECK (content_revision >= 1),
  status varchar(24) NOT NULL DEFAULT 'UPLOADING' CHECK (
    status IN ('UPLOADING', 'QUEUED', 'PROCESSING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REJECTED')
  ),
  optimistic_version integer NOT NULL DEFAULT 1 CHECK (optimistic_version >= 1),
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_document_version_number UNIQUE (document_id, version_number)
);

CREATE INDEX idx_document_versions_document ON document_versions (document_id, version_number DESC);
CREATE INDEX idx_document_versions_status ON document_versions (status, updated_at DESC);

CREATE TABLE document_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  original_file_name varchar(240) NOT NULL,
  bucket varchar(63) NOT NULL,
  object_key varchar(1024) NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_type varchar(160) NOT NULL,
  etag varchar(160),
  sha256 char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_document_file_version UNIQUE (document_version_id),
  CONSTRAINT ck_document_file_sha256 CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$')
);

CREATE TABLE ingestion_jobs (
  id varchar(300) PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  content_revision integer NOT NULL CHECK (content_revision >= 1),
  pipeline_version integer NOT NULL CHECK (pipeline_version >= 1),
  status varchar(16) NOT NULL DEFAULT 'QUEUED' CHECK (
    status IN ('QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REJECTED')
  ),
  current_step varchar(32),
  overall_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (overall_percent BETWEEN 0 AND 100),
  public_message varchar(500),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  lease_owner varchar(128),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ingestion_job_revision UNIQUE (document_version_id, content_revision, pipeline_version),
  CONSTRAINT ck_ingestion_current_step CHECK (
    current_step IS NULL OR current_step IN (
      'SECURITY_SCAN', 'PARSE', 'OCR', 'NORMALIZE', 'CHUNK',
      'QUALITY_GATE', 'EMBED', 'INDEX', 'VERIFY', 'PUBLISH'
    )
  )
);

CREATE INDEX idx_ingestion_jobs_status_updated ON ingestion_jobs (status, updated_at DESC, id DESC);
CREATE INDEX idx_ingestion_jobs_lease ON ingestion_jobs (lease_expires_at)
  WHERE status = 'RUNNING';

CREATE TABLE ingestion_job_steps (
  id varchar(300) PRIMARY KEY,
  job_id varchar(300) NOT NULL REFERENCES ingestion_jobs(id),
  step_name varchar(32) NOT NULL CHECK (
    step_name IN (
      'SECURITY_SCAN', 'PARSE', 'OCR', 'NORMALIZE', 'CHUNK',
      'QUALITY_GATE', 'EMBED', 'INDEX', 'VERIFY', 'PUBLISH'
    )
  ),
  step_version integer NOT NULL DEFAULT 1 CHECK (step_version >= 1),
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 100),
  status varchar(16) NOT NULL DEFAULT 'QUEUED' CHECK (
    status IN ('QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REJECTED')
  ),
  weight_percent numeric(5,2) NOT NULL CHECK (weight_percent BETWEEN 0 AND 100),
  processed_units bigint NOT NULL DEFAULT 0 CHECK (processed_units >= 0),
  total_units bigint CHECK (total_units > 0),
  stage_percent numeric(5,2) CHECK (stage_percent BETWEEN 0 AND 100),
  overall_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (overall_percent BETWEEN 0 AND 100),
  public_message varchar(500),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ingestion_job_step UNIQUE (job_id, step_name, step_version)
);

CREATE INDEX idx_ingestion_steps_job_position ON ingestion_job_steps (job_id, position);
CREATE INDEX idx_ingestion_steps_running_heartbeat ON ingestion_job_steps (heartbeat_at)
  WHERE status = 'RUNNING';

CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED')
  ),
  created_by varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_upload_sessions_owner_created ON upload_sessions (created_by, created_at DESC);
CREATE INDEX idx_upload_sessions_expiry ON upload_sessions (expires_at) WHERE status = 'ACTIVE';

CREATE TABLE upload_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_session_id uuid NOT NULL REFERENCES upload_sessions(id),
  client_file_id varchar(100) NOT NULL,
  original_file_name varchar(240) NOT NULL,
  strategy varchar(16) NOT NULL CHECK (strategy IN ('SINGLE', 'MULTIPART')),
  bucket varchar(63) NOT NULL,
  object_key varchar(1024) NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  content_type varchar(160) NOT NULL,
  expected_sha256 char(64),
  multipart_upload_id varchar(512),
  part_size_bytes integer NOT NULL CHECK (part_size_bytes >= 5242880),
  part_count integer NOT NULL CHECK (part_count >= 1),
  status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'COMPLETED', 'CANCELLED')
  ),
  document_id uuid REFERENCES documents(id),
  document_version_id uuid REFERENCES document_versions(id),
  document_file_id uuid REFERENCES document_files(id),
  ingestion_job_id varchar(300) REFERENCES ingestion_jobs(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_upload_client_file UNIQUE (upload_session_id, client_file_id),
  CONSTRAINT ck_upload_expected_sha256 CHECK (
    expected_sha256 IS NULL OR expected_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT ck_upload_multipart_id CHECK (
    (strategy = 'MULTIPART' AND multipart_upload_id IS NOT NULL)
    OR (strategy = 'SINGLE' AND multipart_upload_id IS NULL)
  )
);

CREATE INDEX idx_upload_files_session ON upload_files (upload_session_id, created_at);

CREATE TABLE ingestion_job_events (
  id bigserial PRIMARY KEY,
  job_id varchar(300) NOT NULL REFERENCES ingestion_jobs(id),
  event_type varchar(100) NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ingestion_job_events_replay ON ingestion_job_events (job_id, id);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type varchar(80) NOT NULL,
  aggregate_id varchar(300) NOT NULL,
  event_type varchar(100) NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by varchar(128),
  locked_until timestamptz,
  last_error varchar(500),
  CONSTRAINT uq_outbox_aggregate_event UNIQUE (aggregate_id, event_type)
);

CREATE INDEX idx_outbox_unpublished ON outbox_events (available_at, occurred_at)
  WHERE published_at IS NULL;

-- Consumer 在执行副作用前插入收据；同一事件/消费者组合只能成功一次。
CREATE TABLE outbox_consumer_receipts (
  consumer_name varchar(100) NOT NULL,
  event_id uuid NOT NULL REFERENCES outbox_events(id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);

