/**
 * Provider 边界的稳定错误。
 * Worker 只看 failureClass/code 决定重试，不解析 Scanner/Docling/OCR 的自然语言错误。
 *
 * @requirement PAR-013
 */
import type { ProcessingFailureClass } from '@rag/contracts';

export class ProcessingProviderError extends Error {
  public constructor(
    public readonly failureClass: ProcessingFailureClass,
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProcessingProviderError';
  }
}
