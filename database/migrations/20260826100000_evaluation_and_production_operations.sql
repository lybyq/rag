-- OPS-001～OPS-004：版本化评测数据、运行、Case 结果、指标与基线。
CREATE TABLE evaluation_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  description varchar(2000) NOT NULL,
  version varchar(40) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
  created_by varchar(128) NOT NULL,
  creator_roles text[] NOT NULL,
  creator_authz_version bigint NOT NULL CHECK (creator_authz_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);

CREATE TABLE evaluation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES evaluation_datasets(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  external_key varchar(120) NOT NULL,
  title varchar(240) NOT NULL,
  dimension varchar(24) NOT NULL CHECK (
    dimension IN ('PARSING','CHUNKING','RETRIEVAL','CITATION','ANSWER','REFUSAL','CONFLICT','AUTHORIZATION','SECURITY')
  ),
  question text CHECK (question IS NULL OR length(question) BETWEEN 1 AND 8000),
  requested_space_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  document_version_id uuid REFERENCES document_versions(id),
  processing_run_id uuid REFERENCES knowledge_processing_runs(id),
  expectation jsonb NOT NULL CHECK (jsonb_typeof(expectation) = 'object'),
  fixture_actual jsonb CHECK (fixture_actual IS NULL OR jsonb_typeof(fixture_actual) = 'object'),
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, ordinal),
  UNIQUE (dataset_id, external_key)
);

CREATE INDEX idx_evaluation_cases_dimension ON evaluation_cases (dataset_id, dimension, ordinal);

CREATE TABLE evaluation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES evaluation_datasets(id),
  baseline_id uuid,
  status varchar(16) NOT NULL DEFAULT 'QUEUED' CHECK (
    status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')
  ),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  metrics jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(metrics) = 'array'),
  regressions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(regressions) = 'array'),
  total_cases integer NOT NULL CHECK (total_cases >= 0),
  completed_cases integer NOT NULL DEFAULT 0 CHECK (completed_cases >= 0),
  passed_cases integer NOT NULL DEFAULT 0 CHECK (passed_cases >= 0),
  created_by varchar(128) NOT NULL,
  creator_roles text[] NOT NULL,
  creator_authz_version bigint NOT NULL CHECK (creator_authz_version >= 0),
  creator_roles_sha256 char(64) NOT NULL CHECK (creator_roles_sha256 ~ '^[a-f0-9]{64}$'),
  note varchar(500),
  lease_owner varchar(180),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_evaluation_runs_recent ON evaluation_runs (created_at DESC, id DESC);
CREATE INDEX idx_evaluation_runs_ready ON evaluation_runs (status, completed_cases, total_cases, lease_expires_at);

CREATE TABLE evaluation_case_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_run_id uuid NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES evaluation_cases(id),
  rag_run_id uuid REFERENCES rag_runs(id),
  status varchar(16) NOT NULL DEFAULT 'QUEUED' CHECK (
    status IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR')
  ),
  actual jsonb CHECK (actual IS NULL OR jsonb_typeof(actual) = 'object'),
  scores jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scores) = 'object'),
  failure_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(180),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evaluation_run_id, case_id)
);

CREATE INDEX idx_evaluation_case_claim
  ON evaluation_case_results (status, available_at, lease_expires_at, created_at);
CREATE INDEX idx_evaluation_case_rag_run ON evaluation_case_results (rag_run_id) WHERE rag_run_id IS NOT NULL;

-- 评分事实与用户可见消息元数据隔离，普通问答 API 不会返回隐藏检索候选。
CREATE TABLE rag_run_evaluation_facts (
  run_id uuid PRIMARY KEY REFERENCES rag_runs(id) ON DELETE CASCADE,
  retrieved_document_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  retrieved_chunk_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  claims jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(claims) = 'array'),
  security_violations text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluation_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  evaluation_run_id uuid NOT NULL UNIQUE REFERENCES evaluation_runs(id),
  dataset_id uuid NOT NULL REFERENCES evaluation_datasets(id),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'array'),
  created_by varchar(128) NOT NULL,
  reason varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, name)
);

ALTER TABLE evaluation_runs
  ADD CONSTRAINT fk_evaluation_run_baseline
  FOREIGN KEY (baseline_id) REFERENCES evaluation_baselines(id);

-- OPS-016：系统/知识空间 Feature Flag 使用版本和灰度百分比，支持审计与回退。
CREATE TABLE feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key varchar(80) NOT NULL,
  scope varchar(16) NOT NULL CHECK (scope IN ('SYSTEM','SPACE')),
  space_id uuid REFERENCES knowledge_spaces(id),
  enabled boolean NOT NULL,
  rollout_percent integer NOT NULL CHECK (rollout_percent BETWEEN 0 AND 100),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  reason varchar(500) NOT NULL,
  updated_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'SYSTEM' AND space_id IS NULL) OR (scope = 'SPACE' AND space_id IS NOT NULL))
);

CREATE UNIQUE INDEX uq_feature_flag_system ON feature_flags (flag_key) WHERE scope = 'SYSTEM';
CREATE UNIQUE INDEX uq_feature_flag_space ON feature_flags (flag_key, space_id) WHERE scope = 'SPACE';

-- OPS-005/017：告警表只保存可公开摘要和 Runbook 键，内部异常留在受控日志与 Trace。
CREATE TABLE operational_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity varchar(16) NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  code varchar(100) NOT NULL,
  title varchar(200) NOT NULL,
  public_message varchar(500) NOT NULL,
  resource_type varchar(80) NOT NULL,
  resource_id varchar(180),
  runbook_key varchar(100) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  fingerprint_sha256 char(64) NOT NULL CHECK (fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_operational_alert_open_fingerprint
  ON operational_alerts (fingerprint_sha256) WHERE status <> 'RESOLVED';
CREATE INDEX idx_operational_alert_recent ON operational_alerts (status, severity, occurred_at DESC);

-- OPS-005：每个 API/Worker 实例周期上报最小心跳，Dashboard 不依赖进程内内存。
CREATE TABLE service_instance_heartbeats (
  instance_id varchar(180) PRIMARY KEY,
  service_name varchar(80) NOT NULL,
  service_kind varchar(16) NOT NULL CHECK (service_kind IN ('API','WORKER')),
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_service_heartbeat_recent
  ON service_instance_heartbeats (service_name,last_seen_at DESC);

-- OPS-018：删除/导出/轮换等合规动作使用幂等任务事实，禁止只靠一次性脚本。
CREATE TABLE compliance_operation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key varchar(200) NOT NULL UNIQUE,
  operation_type varchar(32) NOT NULL CHECK (
    operation_type IN ('RETENTION_DELETE','AUDIT_EXPORT','SECURITY_RESPONSE','KEY_ROTATION')
  ),
  requested_by varchar(128) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'QUEUED' CHECK (
    status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')
  ),
  request_summary jsonb NOT NULL CHECK (jsonb_typeof(request_summary) = 'object'),
  result_summary jsonb CHECK (result_summary IS NULL OR jsonb_typeof(result_summary) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_compliance_jobs_status ON compliance_operation_jobs (status, created_at);
-- migration-phase: expand
