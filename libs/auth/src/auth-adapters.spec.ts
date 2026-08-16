import type { AuthorizationVersionPort } from '@rag/contracts';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  AuthenticationError,
  createTrustedHeaderSignature,
  JwtAuthAdapter,
  MockAuthAdapter,
  RoleMapper,
  TrustedHeaderAuthAdapter,
} from './index';

const versionProvider: AuthorizationVersionPort = {
  getCurrentVersion: async () => 7,
};

const roleMapper = new RoleMapper({
  intranet_admin: ['KNOWLEDGE_ADMIN'],
  intranet_editor: ['KNOWLEDGE_EDITOR'],
});

/** 用 Node 原生 RSA 生成标准 compact JWT，让测试覆盖真实 `jose.jwtVerify`。 */
function signTestJwt(
  payload: Readonly<Record<string, unknown>>,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'm01-test-key' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${header}.${body}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

describe('[AUTH-002][AUTH-003][AUTH-006] Mock Auth Adapter', () => {
  it('只能选择服务端预置身份，浏览器伪造角色 Header 不会扩权', async () => {
    const adapter = new MockAuthAdapter(
      {
        appEnv: 'development',
        defaultPresetId: 'reader',
        selectionHeader: 'x-rag-mock-user',
        presets: [
          { presetId: 'reader', label: '阅读者', userId: 'reader-1', roles: ['unknown_reader'] },
          { presetId: 'editor', label: '编辑者', userId: 'editor-1', roles: ['intranet_editor'] },
        ],
      },
      roleMapper,
      versionProvider,
    );

    const user = await adapter.authenticate({
      headers: {
        'x-rag-mock-user': 'editor',
        'x-authenticated-roles': 'SYSTEM_ADMIN',
      },
      remoteAddress: '127.0.0.1',
    });

    expect(user).toEqual(
      expect.objectContaining({
        userId: 'editor-1',
        roles: ['KNOWLEDGE_EDITOR'],
        authzVersion: 7,
      }),
    );
  });

  it('production 即使误组装 Adapter 也会再次拒绝启动', () => {
    expect(
      () =>
        new MockAuthAdapter(
          {
            appEnv: 'production',
            defaultPresetId: 'reader',
            selectionHeader: 'x-rag-mock-user',
            presets: [{ presetId: 'reader', label: '阅读者', userId: 'reader-1', roles: [] }],
          },
          roleMapper,
          versionProvider,
        ),
    ).toThrow(/production/);
  });
});

describe('[AUTH-004][AUTH-014] Trusted Header Auth Adapter', () => {
  const config = {
    userHeader: 'x-authenticated-user',
    rolesHeader: 'x-authenticated-roles',
    rolesSeparator: ',',
    trustedProxyCidrs: ['10.0.0.0/8'],
    signatureEnabled: true,
    signatureSecret: 'test-only-secret-that-is-longer-than-32-characters',
    signatureHeader: 'x-auth-signature',
    timestampHeader: 'x-auth-timestamp',
    maxSkewSeconds: 60,
  } as const;
  const nowMs = Date.parse('2026-08-16T08:00:00.000Z');
  const timestamp = String(Math.floor(nowMs / 1000));

  it('受信源和正确 HMAC 签名同时成立才建立身份', async () => {
    const signature = createTrustedHeaderSignature(
      config.signatureSecret,
      timestamp,
      'alice',
      'intranet_admin,forged_role',
    );
    const adapter = new TrustedHeaderAuthAdapter(config, roleMapper, versionProvider, () => nowMs);

    const user = await adapter.authenticate({
      remoteAddress: '10.8.2.3',
      headers: {
        'x-authenticated-user': 'alice',
        'x-authenticated-roles': 'intranet_admin,forged_role',
        'x-auth-timestamp': timestamp,
        'x-auth-signature': signature,
      },
    });

    expect(user.roles).toEqual(['KNOWLEDGE_ADMIN']);
  });

  it('伪造来源、过期时间或错误签名全部 fail-closed', async () => {
    const adapter = new TrustedHeaderAuthAdapter(config, roleMapper, versionProvider, () => nowMs);
    const headers = {
      'x-authenticated-user': 'alice',
      'x-authenticated-roles': 'intranet_admin',
      'x-auth-timestamp': timestamp,
      'x-auth-signature': 'forged',
    };

    await expect(adapter.authenticate({ remoteAddress: '203.0.113.10', headers })).rejects.toThrow(
      AuthenticationError,
    );
    await expect(adapter.authenticate({ remoteAddress: '10.1.1.1', headers })).rejects.toThrow(
      AuthenticationError,
    );
  });
});

describe('[AUTH-005][AUTH-014] JWT Auth Adapter', () => {
  it('验证签名、Issuer、Audience、exp、算法和 Claim 映射', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const resolver = (
      _header: unknown,
      callback: (error: Error | null, key?: string) => void,
    ): void => callback(null, publicPem);
    const adapter = new JwtAuthAdapter(
      {
        jwksUrl: 'https://idp.example.test/.well-known/jwks.json',
        issuer: 'https://idp.example.test',
        audience: 'enterprise-rag',
        userIdClaim: 'sub',
        rolesClaim: 'realm.roles',
        allowedAlgorithms: ['RS256'],
      },
      roleMapper,
      versionProvider,
      resolver,
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const validToken = signTestJwt(
      {
        sub: 'bob',
        iss: 'https://idp.example.test',
        aud: 'enterprise-rag',
        iat: nowSeconds,
        exp: nowSeconds + 300,
        realm: { roles: ['intranet_editor', 'unknown'] },
      },
      privateKey,
    );

    const user = await adapter.authenticate({
      headers: { authorization: `Bearer ${validToken}` },
    });
    expect(user).toEqual(
      expect.objectContaining({ userId: 'bob', roles: ['KNOWLEDGE_EDITOR'], authzVersion: 7 }),
    );

    const wrongAudienceToken = signTestJwt(
      {
        sub: 'bob',
        iss: 'https://idp.example.test',
        aud: 'another-service',
        iat: nowSeconds,
        exp: nowSeconds + 300,
        realm: { roles: ['intranet_editor'] },
      },
      privateKey,
    );
    await expect(
      adapter.authenticate({ headers: { authorization: `Bearer ${wrongAudienceToken}` } }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });
});
