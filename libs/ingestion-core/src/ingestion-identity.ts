/**
 * 入库任务与对象路径的稳定标识规则。
 * 路径永远不使用用户文件名，任务标识显式包含修订和处理器版本。
 *
 * @requirement DOC-007
 * @requirement DOC-010
 */
import type { IngestionStepName } from '@rag/contracts';

/** 构造一次 content revision 的流水线任务 ID。 */
export function createIngestionJobId(
  documentVersionId: string,
  contentRevision: number,
  pipelineVersion: number,
): string {
  return `ingest:${documentVersionId}:revision:${contentRevision}:pipeline:v${pipelineVersion}`;
}

/** 构造可被 BullMQ/Consumer 幂等识别的步骤 Job ID。 */
export function createIngestionStepId(
  documentVersionId: string,
  contentRevision: number,
  step: IngestionStepName,
  stepVersion: number,
): string {
  return `ingest:${documentVersionId}:revision:${contentRevision}:step:${step}:v${stepVersion}`;
}

/** 对象路径只由服务端 UUID 组成，阻断目录穿越、重名覆盖与文件名泄露。 */
export function createIsolatedObjectKey(
  spaceId: string,
  uploadSessionId: string,
  uploadFileId: string,
): string {
  return `spaces/${spaceId}/uploads/${uploadSessionId}/files/${uploadFileId}`;
}
