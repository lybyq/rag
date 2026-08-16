/**
 * 可信反向代理 Header 认证。
 * 同时校验直接连接源地址，并可校验带时间戳的 HMAC，防止浏览器伪造同名 Header。
 *
 * @requirement AUTH-004
 * @requirement AUTH-014
 */
import type {
  AuthPort,
  AuthenticationRequest,
  AuthorizationVersionPort,
  UserContext,
} from '@rag/contracts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthenticationError } from './authentication.error';
import { readSingleHeader } from './header-utils';
import { createAuthenticatedContext } from './identity-factory';
import type { RoleMapper } from './role-mapper';

export interface TrustedHeaderAuthConfig {
  readonly userHeader: string;
  readonly rolesHeader: string;
  readonly rolesSeparator: string;
  readonly trustedProxyCidrs: readonly string[];
  readonly signatureEnabled: boolean;
  readonly signatureSecret?: string;
  readonly signatureHeader: string;
  readonly timestampHeader: string;
  readonly maxSkewSeconds: number;
}

/** 网关和服务端必须使用相同顺序构造签名原文。 */
export function createTrustedHeaderSignature(
  secret: string,
  timestamp: string,
  userId: string,
  rolesValue: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${userId}\n${rolesValue}`, 'utf8')
    .digest('hex');
}

/** 将 IPv4 转成无符号 32 位整数，用掩码判断网段。 */
function ipv4ToInteger(address: string): number | undefined {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return undefined;
  }
  return octets.reduce((result, value) => ((result << 8) | value) >>> 0, 0);
}

/** 支持内网常用 IPv4 CIDR，并支持 `/128` IPv6 精确地址。 */
function addressMatchesCidr(remoteAddress: string, cidr: string): boolean {
  const normalizedAddress = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
  const [network = '', prefixText = ''] = cidr.split('/');

  const addressInteger = ipv4ToInteger(normalizedAddress);
  const networkInteger = ipv4ToInteger(network);
  if (addressInteger !== undefined && networkInteger !== undefined) {
    const prefix = Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (addressInteger & mask) === (networkInteger & mask);
  }

  return prefixText === '128' && normalizedAddress.toLowerCase() === network.toLowerCase();
}

/** 构造阶段验证 CIDR，避免拼写错误把系统变成运行时全 401。 */
function isSupportedCidr(cidr: string): boolean {
  const [network = '', prefixText = ''] = cidr.split('/');
  const prefix = Number(prefixText);
  if (ipv4ToInteger(network) !== undefined) {
    return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
  }
  return network.includes(':') && prefix === 128;
}

/** 常量时间比较签名，长度不同时也统一返回 false。 */
function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export class TrustedHeaderAuthAdapter implements AuthPort {
  public constructor(
    private readonly config: TrustedHeaderAuthConfig,
    private readonly roleMapper: RoleMapper,
    private readonly versionProvider: AuthorizationVersionPort,
    private readonly now: () => number = Date.now,
  ) {
    if (config.trustedProxyCidrs.length === 0) throw new Error('Trusted Header 缺少受信代理网段');
    if (!config.trustedProxyCidrs.every(isSupportedCidr)) {
      throw new Error('Trusted Header 包含不受支持的 CIDR；IPv6 首版要求 /128 精确地址');
    }
    if (
      config.signatureEnabled &&
      (!config.signatureSecret || config.signatureSecret.length < 32)
    ) {
      throw new Error('Trusted Header 签名密钥至少 32 个字符');
    }
  }

  public async authenticate(request: AuthenticationRequest): Promise<UserContext> {
    if (
      !request.remoteAddress ||
      !this.config.trustedProxyCidrs.some((cidr) =>
        addressMatchesCidr(request.remoteAddress!, cidr),
      )
    ) {
      throw new AuthenticationError('AUTH_SOURCE_UNTRUSTED', '认证来源不受信任');
    }

    const userId = readSingleHeader(request.headers, this.config.userHeader);
    const rolesValue = readSingleHeader(request.headers, this.config.rolesHeader);
    if (this.config.signatureEnabled) this.verifySignature(request, userId, rolesValue);

    const sourceRoles = rolesValue
      .split(this.config.rolesSeparator)
      .map((role) => role.trim())
      .filter(Boolean);
    return createAuthenticatedContext(
      userId,
      sourceRoles,
      this.roleMapper,
      this.versionProvider,
      this.now,
    );
  }

  private verifySignature(
    request: AuthenticationRequest,
    userId: string,
    rolesValue: string,
  ): void {
    const timestamp = readSingleHeader(request.headers, this.config.timestampHeader);
    const signature = readSingleHeader(request.headers, this.config.signatureHeader);
    const timestampSeconds = Number(timestamp);
    if (!Number.isInteger(timestampSeconds)) {
      throw new AuthenticationError('AUTH_INVALID', '认证签名无效');
    }
    const skewSeconds = Math.abs(this.now() / 1000 - timestampSeconds);
    if (skewSeconds > this.config.maxSkewSeconds) {
      throw new AuthenticationError('AUTH_INVALID', '认证签名已过期');
    }

    const expected = createTrustedHeaderSignature(
      this.config.signatureSecret!,
      timestamp,
      userId,
      rolesValue,
    );
    if (!signaturesMatch(expected, signature)) {
      throw new AuthenticationError('AUTH_INVALID', '认证签名无效');
    }
  }
}
