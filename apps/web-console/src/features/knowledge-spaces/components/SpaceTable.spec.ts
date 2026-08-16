import type { KnowledgeSpace } from '@rag/contracts';
import { describe, expect, it } from 'vitest';
import { getSpaceActionVisibility } from './spaceActions';

function space(permissions: KnowledgeSpace['effectivePermissions']): KnowledgeSpace {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    code: 'hr-policy',
    name: '人力制度库',
    description: null,
    ownerUserId: 'owner-1',
    status: 'ACTIVE',
    version: 1,
    policyVersion: 1,
    documentCount: 0,
    createdAt: '2026-08-16T08:00:00.000Z',
    updatedAt: '2026-08-16T08:00:00.000Z',
    effectivePermissions: permissions,
  };
}

describe('[WEB-007] SpaceTable action visibility', () => {
  it('READ 用户看不到授权、编辑和停用操作', () => {
    expect(getSpaceActionVisibility(space(['READ']))).toEqual({
      manage: false,
      edit: false,
      deactivate: false,
    });
  });

  it('ADMIN 用户看到治理操作', () => {
    expect(getSpaceActionVisibility(space(['READ', 'WRITE', 'REVIEW', 'ADMIN']))).toEqual({
      manage: true,
      edit: true,
      deactivate: true,
    });
  });
});
