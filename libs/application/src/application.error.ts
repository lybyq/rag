/** 应用层可安全映射到 HTTP 的稳定错误。 */
export class ApplicationError extends Error {
  public constructor(
    public readonly code: 'ACCESS_DENIED' | 'NOT_FOUND' | 'VERSION_CONFLICT' | 'DUPLICATE_RESOURCE',
    public readonly httpStatus: 403 | 404 | 409,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}
