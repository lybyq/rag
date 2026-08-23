/** 应用层可安全映射到 HTTP 的稳定错误。 */
export class ApplicationError extends Error {
  public constructor(
    public readonly code:
      | 'ACCESS_DENIED'
      | 'NOT_FOUND'
      | 'VERSION_CONFLICT'
      | 'DUPLICATE_RESOURCE'
      | 'UPLOAD_LIMIT_EXCEEDED'
      | 'UPLOAD_EXPIRED'
      | 'OBJECT_MISMATCH'
      | 'INVALID_STATE'
      | 'PROVIDER_PROFILE_MISMATCH'
      | 'SCHEMA_MISMATCH'
      | 'CONTENT_REDACTED'
      | 'DEADLINE_EXCEEDED'
      | 'EMBEDDING_FAILED'
      | 'RETRIEVAL_UNAVAILABLE'
      | 'RATE_LIMITED'
      | 'TRAFFIC_CONTROL_UNAVAILABLE',
    public readonly httpStatus: 403 | 404 | 408 | 409 | 410 | 413 | 429 | 500 | 502 | 503,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}
