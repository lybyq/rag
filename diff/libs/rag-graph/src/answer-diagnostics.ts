/**
 * OPT-001：答案阶段的安全诊断分类，连接图审计和运行生命周期。
 * 外部错误对象的 code/message 均不可信；只返回本地封闭分类，不做业务拒答或重试决定。
 */

/** OPT-001：允许写入持久化审计的固定故障分类，未知值丢弃原文。 */
export function answerDiagnosticErrorCode(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return 'CANCELLED';
  const allowed = new Set([
    'TIMEOUT',
    'CANCELLED',
    'RATE_LIMITED',
    'UPSTREAM_5XX',
    'NETWORK',
    'AUTHENTICATION',
    'SCHEMA_ERROR',
    'VERSION_MISMATCH',
    'PARTIAL_RESULT',
  ]);
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'UNKNOWN';
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && allowed.has(code) ? code : 'UNKNOWN';
}
