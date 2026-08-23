# Database migrations

业务 migration 从 身份权限与知识空间 开始加入，文件名必须使用 `YYYYMMDDHHmmss_description.sql`。破坏性变更必须拆成向后兼容的 expand/migrate/contract 阶段；紧急例外需要在 SQL 中加入 `-- reviewed-destructive-change` 并通过人工评审。
