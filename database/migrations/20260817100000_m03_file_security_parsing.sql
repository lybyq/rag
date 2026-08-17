-- M03：文件安全事实、解析运行、统一 DocumentBlock 与可定位问题。
-- 原始文件仍留在隔离 Bucket；只有通过安全门禁的派生 Block 快照才能进入 derived Bucket。

ALTER TABLE document_files
  ADD COLUMN trusted_sha256 char(64),
  ADD COLUMN detected_mime varchar(160),
  ADD COLUMN file_format varchar(16),
  ADD COLUMN scan_status varchar(20) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN scan_engine varchar(100),
  ADD COLUMN scan_revision varchar(100),
  ADD COLUMN scan_completed_at timestamptz,
  ADD COLUMN security_findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT ck_document_file_trusted_sha256 CHECK (
    trusted_sha256 IS NULL OR trusted_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT ck_document_file_format CHECK (
    file_format IS NULL OR file_format IN (
      'PDF', 'DOCX', 'XLSX', 'PPTX', 'IMAGE', 'HTML', 'MARKDOWN', 'TEXT', 'CSV'
    )
  ),
  ADD CONSTRAINT ck_document_file_scan_status CHECK (
    scan_status IN ('PENDING', 'CLEAN', 'MANUAL_REVIEW', 'REJECTED', 'FAILED')
  ),
  ADD CONSTRAINT ck_document_file_security_findings CHECK (
    jsonb_typeof(security_findings) = 'array'
  );

CREATE INDEX idx_document_files_scan_status ON document_files (scan_status, created_at);
CREATE INDEX idx_document_files_trusted_sha256 ON document_files (trusted_sha256)
  WHERE trusted_sha256 IS NOT NULL;

CREATE TABLE document_parse_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id varchar(300) NOT NULL REFERENCES ingestion_jobs(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  content_revision integer NOT NULL CHECK (content_revision >= 1),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status varchar(16) NOT NULL CHECK (
    status IN ('RUNNING', 'SUCCEEDED', 'WAITING', 'FAILED', 'REJECTED')
  ),
  file_format varchar(16),
  declared_mime varchar(160),
  detected_mime varchar(160),
  input_sha256 char(64),
  security_verdict varchar(20),
  malware_engine varchar(100),
  malware_revision varchar(100),
  parser_profile_id varchar(100) NOT NULL,
  parser_revision varchar(100) NOT NULL,
  ocr_profile_id varchar(100) NOT NULL,
  ocr_revision varchar(100) NOT NULL,
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  block_count integer NOT NULL DEFAULT 0 CHECK (block_count >= 0),
  ocr_page_count integer NOT NULL DEFAULT 0 CHECK (ocr_page_count >= 0),
  derived_bucket varchar(63),
  derived_object_key varchar(1024),
  derived_sha256 char(64),
  failure_class varchar(32),
  failure_code varchar(100),
  failure_message varchar(500),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_document_parse_run_job UNIQUE (job_id),
  CONSTRAINT ck_document_parse_run_format CHECK (
    file_format IS NULL OR file_format IN (
      'PDF', 'DOCX', 'XLSX', 'PPTX', 'IMAGE', 'HTML', 'MARKDOWN', 'TEXT', 'CSV'
    )
  ),
  CONSTRAINT ck_document_parse_run_sha CHECK (
    input_sha256 IS NULL OR input_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT ck_document_parse_derived_sha CHECK (
    derived_sha256 IS NULL OR derived_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT ck_document_parse_security CHECK (
    security_verdict IS NULL OR security_verdict IN ('CLEAN', 'MANUAL_REVIEW', 'REJECTED')
  ),
  CONSTRAINT ck_document_parse_failure_class CHECK (
    failure_class IS NULL OR failure_class IN (
      'RETRYABLE_PROVIDER', 'DOCUMENT_PROBLEM', 'DEVELOPER_DEFECT'
    )
  ),
  CONSTRAINT ck_document_parse_metrics CHECK (jsonb_typeof(metrics) = 'object')
);

CREATE INDEX idx_parse_runs_version_revision
  ON document_parse_runs (document_version_id, content_revision DESC, created_at DESC);
CREATE INDEX idx_parse_runs_status_updated ON document_parse_runs (status, updated_at DESC);

CREATE TABLE document_blocks (
  id varchar(160) PRIMARY KEY,
  parse_run_id uuid NOT NULL REFERENCES document_parse_runs(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  content_revision integer NOT NULL CHECK (content_revision >= 1),
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  block_type varchar(24) NOT NULL CHECK (
    block_type IN (
      'TITLE', 'PARAGRAPH', 'LIST', 'TABLE', 'TABLE_ROW', 'IMAGE', 'CAPTION',
      'CODE', 'FORMULA', 'HEADER', 'FOOTER', 'FOOTNOTE'
    )
  ),
  text_content text NOT NULL,
  original_text text NOT NULL,
  page_no integer CHECK (page_no IS NULL OR page_no >= 1),
  sheet_name varchar(200),
  slide_no integer CHECK (slide_no IS NULL OR slide_no >= 1),
  bbox jsonb,
  heading_level smallint CHECK (heading_level IS NULL OR heading_level BETWEEN 1 AND 6),
  parent_block_id varchar(160),
  confidence numeric(6,5) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  table_data jsonb,
  parser_name varchar(100) NOT NULL,
  parser_revision varchar(100) NOT NULL,
  ocr_engine varchar(100),
  ocr_revision varchar(100),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_document_block_ordinal UNIQUE (
    document_version_id, content_revision, ordinal
  ),
  CONSTRAINT fk_document_block_parent FOREIGN KEY (parent_block_id) REFERENCES document_blocks(id),
  CONSTRAINT ck_document_block_bbox CHECK (bbox IS NULL OR jsonb_typeof(bbox) = 'object'),
  CONSTRAINT ck_document_block_table CHECK (
    table_data IS NULL OR jsonb_typeof(table_data) = 'object'
  ),
  CONSTRAINT ck_document_block_metadata CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT ck_document_block_sha CHECK (content_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX idx_document_blocks_parse_ordinal ON document_blocks (parse_run_id, ordinal);
CREATE INDEX idx_document_blocks_page ON document_blocks (document_version_id, content_revision, page_no)
  WHERE page_no IS NOT NULL;

CREATE TABLE document_parse_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parse_run_id uuid NOT NULL REFERENCES document_parse_runs(id),
  severity varchar(12) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'ERROR')),
  code varchar(100) NOT NULL,
  message varchar(500) NOT NULL,
  page_no integer CHECK (page_no IS NULL OR page_no >= 1),
  block_id varchar(160) REFERENCES document_blocks(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_document_parse_issue_metadata CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_parse_issues_run_severity
  ON document_parse_issues (parse_run_id, severity, created_at);
