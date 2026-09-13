-- OPT-013：外部业务批次幂等和长期文档身份映射。
-- client_file_id 仍只是单批次临时关联；长期更新只能依赖 source + external_document_id + 内容 Hash。

ALTER TABLE upload_files
  ADD COLUMN external_source_id varchar(128),
  ADD COLUMN external_document_id varchar(256),
  ADD CONSTRAINT ck_upload_external_identity_pair CHECK (
    (external_source_id IS NULL AND external_document_id IS NULL)
    OR (external_source_id IS NOT NULL AND external_document_id IS NOT NULL)
  );

CREATE TABLE external_import_batches (
  space_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  idempotency_key varchar(200) NOT NULL,
  request_sha256 char(64) NOT NULL,
  upload_session_id uuid NOT NULL UNIQUE REFERENCES upload_sessions(id),
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, idempotency_key),
  CONSTRAINT ck_external_batch_request_sha256 CHECK (request_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX idx_external_import_batches_owner_created
  ON external_import_batches (created_by, created_at DESC);

CREATE TABLE external_document_bindings (
  space_id uuid NOT NULL REFERENCES knowledge_spaces(id),
  external_source_id varchar(128) NOT NULL,
  external_document_id varchar(256) NOT NULL,
  document_id uuid NOT NULL UNIQUE REFERENCES documents(id),
  last_content_sha256 char(64) NOT NULL,
  latest_document_version_id uuid NOT NULL REFERENCES document_versions(id),
  latest_document_file_id uuid NOT NULL REFERENCES document_files(id),
  latest_ingestion_job_id varchar(300) NOT NULL REFERENCES ingestion_jobs(id),
  created_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, external_source_id, external_document_id),
  CONSTRAINT ck_external_document_content_sha256 CHECK (last_content_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX idx_external_document_bindings_document
  ON external_document_bindings (document_id);

COMMENT ON TABLE external_import_batches IS
  'OPT-013：请求级幂等键绑定完整批次 Hash；同键不同请求必须冲突。';
COMMENT ON TABLE external_document_bindings IS
  'OPT-013：外部来源稳定文档身份绑定平台 Document；内容变化创建新 Version。';
