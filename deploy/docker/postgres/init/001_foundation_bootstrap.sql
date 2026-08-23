-- 工程与决策基线 只启用通用 UUID 能力；业务表从 身份权限与知识空间 起通过正式 migration 创建。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
