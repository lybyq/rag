-- CFG-007：把部署画像固化在 M03/M04 Run 上；后续切换环境不能改写历史结果的来源。
-- 旧数据只能确定来自迁移前的默认外网开发画像，因此使用 external-dev 回填。
ALTER TABLE document_parse_runs
  ADD COLUMN provider_profile varchar(40) NOT NULL DEFAULT 'external-dev',
  ADD CONSTRAINT ck_document_parse_provider_profile CHECK (
    provider_profile IN (
      'test', 'external-dev', 'external-ci', 'intranet-staging', 'intranet-production'
    )
  );

ALTER TABLE knowledge_processing_runs
  ADD COLUMN provider_profile varchar(40) NOT NULL DEFAULT 'external-dev',
  ADD CONSTRAINT ck_knowledge_processing_provider_profile CHECK (
    provider_profile IN (
      'test', 'external-dev', 'external-ci', 'intranet-staging', 'intranet-production'
    )
  );

COMMENT ON COLUMN document_parse_runs.provider_profile IS
  'Run 开始时锁定的受控 Provider Profile；与 parser/ocr revision 共同用于复现。';
COMMENT ON COLUMN knowledge_processing_runs.provider_profile IS
  'Run 开始时锁定的受控 Provider Profile；与 chunker/tokenizer/rule revision 共同用于复现。';
