/**
 * 认证边界只向上暴露稳定错误码和安全文案。
 * 原始 Token、签名值和 jose 内部错误只能进入受控调试上下文，不能返回客户端。
 *
 * @requirement AUTH-014
 */
export type AuthenticationErrorCode = 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'AUTH_SOURCE_UNTRUSTED';

/** 可由全局异常过滤器安全识别的认证失败。 */
export class AuthenticationError extends Error {
  public readonly httpStatus = 401;
  public readonly retryable = false;

  public constructor(
    public readonly code: AuthenticationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}
