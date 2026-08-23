/** @requirement ANS-003 */
import { createHash } from 'node:crypto';
import { rehydrateRunUserContext } from './run-identity.factory';

describe('[ANS-003] 后台 Run 身份恢复', () => {
  it('只接受与冻结摘要一致的服务端角色', () => {
    const roles = ['KNOWLEDGE_READER'] as const;
    const hash = createHash('sha256').update(roles.join('\u001f')).digest('hex');
    expect(
      rehydrateRunUserContext({
        userId: 'reader-1',
        roles,
        authzVersion: 3,
        currentAuthzVersion: 4,
        expectedAuthzVersion: 3,
        expectedRolesSha256: hash,
      }),
    ).toMatchObject({ userId: 'reader-1', roles, authzVersion: 4 });
  });

  it('拒绝角色或授权版本被篡改的执行事实', () => {
    expect(() =>
      rehydrateRunUserContext({
        userId: 'reader-1',
        roles: ['SYSTEM_ADMIN'],
        authzVersion: 4,
        expectedAuthzVersion: 3,
        expectedRolesSha256: '0'.repeat(64),
      }),
    ).toThrow(/无法验证/);
  });
});
