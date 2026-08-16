import {
  CreateKnowledgeSpaceRequestSchema,
  UpsertSpaceGrantRequestSchema,
  UserContextSchema,
} from './index';

describe('[AUTH-001][AUTH-008][AUTH-009] M01 runtime contracts', () => {
  it('可信身份只接受已知系统语义角色', () => {
    const result = UserContextSchema.safeParse({
      userId: 'alice',
      roles: ['KNOWLEDGE_ADMIN', 'FAKE_SUPER_ADMIN'],
      authzVersion: 3,
      resolvedAt: '2026-08-16T08:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('ROLE ACL 拒绝伪造的未知角色', () => {
    const result = UpsertSpaceGrantRequestSchema.safeParse({
      subjectType: 'ROLE',
      subjectId: 'FAKE_SUPER_ADMIN',
      permissions: ['ADMIN'],
      reason: 'attempt escalation',
    });

    expect(result.success).toBe(false);
  });

  it('空间编码使用稳定的小写 kebab-case', () => {
    expect(
      CreateKnowledgeSpaceRequestSchema.safeParse({
        code: 'hr-policy',
        name: '人力制度库',
        description: null,
      }).success,
    ).toBe(true);
    expect(
      CreateKnowledgeSpaceRequestSchema.safeParse({ code: 'HR Policy', name: '人力制度库' })
        .success,
    ).toBe(false);
  });
});
