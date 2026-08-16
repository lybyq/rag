import type { SpaceGrant } from '@rag/contracts';
import { createTestUserContext } from '@rag/testing';
import {
  expandPermissions,
  isAllowedToCreateKnowledgeSpace,
  matchesAclSubject,
  restrictRequestedSpaceIds,
} from './authorization';

const roleGrant: SpaceGrant = {
  id: '10000000-0000-4000-8000-000000000001',
  spaceId: '20000000-0000-4000-8000-000000000001',
  subjectType: 'ROLE',
  subjectId: 'KNOWLEDGE_EDITOR',
  permissions: ['WRITE'],
  createdBy: 'admin',
  createdAt: '2026-08-16T08:00:00.000Z',
  updatedAt: '2026-08-16T08:00:00.000Z',
};

describe('[AUTH-008] ACL domain rules', () => {
  it('ADMIN 蕴含全部权限，WRITE 只蕴含 READ', () => {
    expect(expandPermissions(['ADMIN'])).toEqual(['READ', 'WRITE', 'REVIEW', 'ADMIN']);
    expect(expandPermissions(['WRITE'])).toEqual(['READ', 'WRITE']);
  });

  it('ROLE ACL 只匹配认证后真实存在的语义角色', () => {
    const editor = createTestUserContext('editor-1', ['KNOWLEDGE_EDITOR']);
    const reader = createTestUserContext('reader-1', ['KNOWLEDGE_READER']);

    expect(matchesAclSubject(editor, roleGrant)).toBe(true);
    expect(matchesAclSubject(reader, roleGrant)).toBe(false);
  });

  it('知识编辑者可以创建空间，但普通阅读者不能', () => {
    expect(isAllowedToCreateKnowledgeSpace(['KNOWLEDGE_EDITOR'])).toBe(true);
    expect(isAllowedToCreateKnowledgeSpace(['KNOWLEDGE_READER'])).toBe(false);
  });
});

describe('[AUTH-011] requested space restriction', () => {
  it('客户端集合只能和服务端集合取交集，不能增加无权空间', () => {
    const allowed = ['space-a', 'space-b'];

    expect(restrictRequestedSpaceIds(allowed, ['space-b', 'space-forged'])).toEqual(['space-b']);
    expect(restrictRequestedSpaceIds(allowed, undefined)).toEqual(allowed);
    expect(restrictRequestedSpaceIds(allowed, [])).toEqual([]);
  });
});
