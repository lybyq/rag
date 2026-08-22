-- M05 IDX-016：Profile 重建必须经过候选构建、离线评测、灰度/全量发布和请求级回退。
-- 普通 space_manifest_heads 仍是稳定线上指针；CANARY 只登记候选，不覆盖稳定版本。

ALTER TABLE index_rebuild_requests
  ADD COLUMN candidate_manifest_id uuid REFERENCES space_manifests(id),
  ADD COLUMN previous_manifest_id uuid REFERENCES space_manifests(id),
  ADD COLUMN pipeline_job_id varchar(300) REFERENCES ingestion_jobs(id),
  ADD COLUMN evaluation_report jsonb CHECK (
    evaluation_report IS NULL OR jsonb_typeof(evaluation_report) = 'object'
  ),
  ADD COLUMN failure_code varchar(100),
  ADD COLUMN failure_message varchar(500),
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_owner varchar(128),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN completed_at timestamptz;

CREATE UNIQUE INDEX uq_index_rebuild_candidate
  ON index_rebuild_requests (candidate_manifest_id)
  WHERE candidate_manifest_id IS NOT NULL;

CREATE UNIQUE INDEX uq_index_rebuild_pipeline_job
  ON index_rebuild_requests (pipeline_job_id)
  WHERE pipeline_job_id IS NOT NULL;

-- 合成重建 Job 复用原文件执行 M03/M04；此映射让 M05 知道候选不能自动切换 Head。
CREATE TABLE index_rebuild_jobs (
  request_id uuid PRIMARY KEY REFERENCES index_rebuild_requests(id),
  job_id varchar(300) NOT NULL UNIQUE REFERENCES ingestion_jobs(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- M06/M07 按稳定 userId Hash 选择候选；未实现在线检索前也能先完成安全发布事实建模。
CREATE TABLE space_manifest_canaries (
  space_id uuid PRIMARY KEY REFERENCES knowledge_spaces(id),
  rebuild_request_id uuid NOT NULL UNIQUE REFERENCES index_rebuild_requests(id),
  stable_manifest_id uuid NOT NULL REFERENCES space_manifests(id),
  candidate_manifest_id uuid NOT NULL UNIQUE REFERENCES space_manifests(id),
  canary_percent integer NOT NULL CHECK (canary_percent BETWEEN 1 AND 99),
  routing_salt uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_canary_distinct_manifests CHECK (stable_manifest_id <> candidate_manifest_id)
);

CREATE INDEX idx_index_rebuild_claim
  ON index_rebuild_requests (status, available_at, created_at)
  WHERE status IN ('QUEUED', 'EVALUATING');

COMMENT ON TABLE space_manifest_canaries IS
  'CANARY 候选不改稳定 Head；M07 根据 userId 稳定哈希和 percent 路由，提升后才原子切 Head。';
