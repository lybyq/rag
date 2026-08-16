/** 基于远程 JWKS 的 JWT 认证 Adapter。 */
import type {
  AuthPort,
  AuthenticationRequest,
  AuthorizationVersionPort,
  UserContext,
} from '@rag/contracts';
import jwt, {
  type Algorithm,
  type GetPublicKeyOrSecret,
  type JwtHeader,
  type JwtPayload,
  type SigningKeyCallback,
} from 'jsonwebtoken';
import createJwksClient from 'jwks-rsa';
import { AuthenticationError } from './authentication.error';
import { readSingleHeader } from './header-utils';
import { createAuthenticatedContext } from './identity-factory';
import type { RoleMapper } from './role-mapper';

export interface JwtAuthConfig {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly userIdClaim: string;
  readonly rolesClaim: string;
  readonly allowedAlgorithms: readonly string[];
}

/** 按 `a.b.c` 路径读取嵌套 Claim，路径不存在时返回 undefined。 */
function readClaim(payload: JwtPayload, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 将 JWT roles Claim 规范为字符串数组，其他类型一律拒绝。 */
function normalizeRolesClaim(value: unknown): readonly string[] {
  if (typeof value === 'string')
    return value
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean);
  if (Array.isArray(value) && value.every((role) => typeof role === 'string')) return value;
  throw new AuthenticationError('AUTH_INVALID', 'JWT 角色 Claim 无效');
}

export class JwtAuthAdapter implements AuthPort {
  private readonly keyResolver: GetPublicKeyOrSecret;
  private readonly allowedAlgorithms: readonly Algorithm[];

  public constructor(
    private readonly config: JwtAuthConfig,
    private readonly roleMapper: RoleMapper,
    private readonly versionProvider: AuthorizationVersionPort,
    keyResolver?: GetPublicKeyOrSecret,
  ) {
    if (
      !config.jwksUrl ||
      !config.issuer ||
      !config.audience ||
      config.allowedAlgorithms.length === 0
    ) {
      throw new Error('JWT Adapter 配置不完整');
    }
    const supportedAlgorithms = new Set<Algorithm>([
      'RS256',
      'RS384',
      'RS512',
      'PS256',
      'PS384',
      'PS512',
      'ES256',
      'ES384',
      'ES512',
    ]);
    if (
      !config.allowedAlgorithms.every((algorithm) =>
        supportedAlgorithms.has(algorithm as Algorithm),
      )
    ) {
      throw new Error('JWT 只允许配置受支持的非对称签名算法');
    }
    this.allowedAlgorithms = config.allowedAlgorithms as readonly Algorithm[];
    this.keyResolver = keyResolver ?? this.createRemoteKeyResolver(config.jwksUrl);
  }

  public async authenticate(request: AuthenticationRequest): Promise<UserContext> {
    const authorization = readSingleHeader(request.headers, 'authorization');
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
    if (!match?.[1]) throw new AuthenticationError('AUTH_INVALID', 'Authorization 格式无效');

    try {
      const payload = await this.verifyToken(match[1]);
      const userId = readClaim(payload, this.config.userIdClaim);
      if (typeof userId !== 'string') {
        throw new AuthenticationError('AUTH_INVALID', 'JWT 用户 Claim 无效');
      }
      const sourceRoles = normalizeRolesClaim(readClaim(payload, this.config.rolesClaim));
      return await createAuthenticatedContext(
        userId,
        sourceRoles,
        this.roleMapper,
        this.versionProvider,
      );
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError('AUTH_INVALID', 'JWT 无法验证');
    }
  }

  /** 使用 `jwks-rsa` 的缓存和请求限流能力解析轮换中的公钥。 */
  private createRemoteKeyResolver(jwksUrl: string): GetPublicKeyOrSecret {
    const client = createJwksClient({ jwksUri: jwksUrl, cache: true, rateLimit: true });
    return (header: JwtHeader, callback: SigningKeyCallback): void => {
      if (!header.kid) {
        callback(new Error('JWT header 缺少 kid'));
        return;
      }
      void client
        .getSigningKey(header.kid)
        .then((key) => callback(null, key.getPublicKey()))
        .catch((error: unknown) =>
          callback(error instanceof Error ? error : new Error('JWKS 失败')),
        );
    };
  }

  /** 把 callback API 收口成 Promise，并额外要求 exp/iss/aud Claim 必须存在。 */
  private async verifyToken(token: string): Promise<JwtPayload> {
    return new Promise<JwtPayload>((resolve, reject) => {
      jwt.verify(
        token,
        this.keyResolver,
        {
          algorithms: [...this.allowedAlgorithms],
          issuer: this.config.issuer,
          audience: this.config.audience,
        },
        (error, decoded) => {
          if (error) {
            reject(error);
            return;
          }
          if (
            typeof decoded !== 'object' ||
            decoded === null ||
            typeof decoded.exp !== 'number' ||
            decoded.iss === undefined ||
            decoded.aud === undefined
          ) {
            reject(new Error('JWT 缺少必需 Claim'));
            return;
          }
          resolve(decoded);
        },
      );
    });
  }
}
