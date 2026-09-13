-- OPT-012 / IDX-011：记录候选 Manifest 开始构建时看到的线上 Head。
--
-- Embedding 与 Milvus 写入是长事务外的远程操作。同一空间多个文件并发入库时，两个候选可能
-- 都从同一个旧 Head 出发；若发布时不核对基线，最后提交的候选会覆盖先提交候选中的新文档。
-- base_manifest_id 用于发布事务内的 CAS 检查，rebase_count 用于生成可审计、可幂等的重排事件。

ALTER TABLE indexing_runs
  ADD COLUMN base_manifest_id uuid REFERENCES space_manifests(id),
  ADD COLUMN rebase_count integer NOT NULL DEFAULT 0 CHECK (rebase_count >= 0);

CREATE INDEX idx_indexing_runs_base_manifest
  ON indexing_runs (base_manifest_id)
  WHERE base_manifest_id IS NOT NULL;

COMMENT ON COLUMN indexing_runs.base_manifest_id IS
  '本次不可见构建复制成员时看到的线上 Head；发布时必须与当前 Head 一致。';

COMMENT ON COLUMN indexing_runs.rebase_count IS
  '因同空间并发发布而自动基于新 Head 重建的次数；不把竞态误报为发布成功。';
