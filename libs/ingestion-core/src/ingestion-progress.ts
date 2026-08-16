/**
 * 入库流水线权重和真实进度算法。
 * 未知总量时保留 null，不根据耗时或定时器伪造 stagePercent。
 *
 * @requirement DOC-013
 * @requirement DOC-014
 */
import type { IngestionExecutionStatus, IngestionStepName, IngestionJobStep } from '@rag/contracts';

/** 权重总和必须是 100；后续调整需版本化 pipeline，而不是热改历史任务。 */
export const INGESTION_STEP_WEIGHTS: Readonly<Record<IngestionStepName, number>> = Object.freeze({
  SECURITY_SCAN: 8,
  PARSE: 20,
  OCR: 12,
  NORMALIZE: 10,
  CHUNK: 15,
  QUALITY_GATE: 10,
  EMBED: 12,
  INDEX: 8,
  VERIFY: 3,
  PUBLISH: 2,
});

/** 固定顺序也是稳定 Step ID 和任务中心显示顺序的依据。 */
export const INGESTION_STEP_ORDER: readonly IngestionStepName[] = Object.freeze([
  'SECURITY_SCAN',
  'PARSE',
  'OCR',
  'NORMALIZE',
  'CHUNK',
  'QUALITY_GATE',
  'EMBED',
  'INDEX',
  'VERIFY',
  'PUBLISH',
]);

/** 计算一个步骤的真实阶段百分比；总量未知时返回 null。 */
export function calculateStagePercent(
  processedUnits: number,
  totalUnits: number | null,
  status: IngestionExecutionStatus,
): number | null {
  if (status === 'SUCCEEDED') return 100;
  if (totalUnits === null) return null;
  if (totalUnits <= 0) return null;
  return roundPercent(Math.min(100, Math.max(0, (processedUnits / totalUnits) * 100)));
}

/**
 * 根据每一步真实完成比例计算总体进度。
 * 未开始和未知总量步骤贡献 0；已成功步骤贡献完整权重。
 */
export function calculateOverallPercent(
  steps: readonly Pick<
    IngestionJobStep,
    'name' | 'status' | 'processedUnits' | 'totalUnits' | 'stagePercent'
  >[],
): number {
  const byName = new Map(steps.map((step) => [step.name, step]));
  const weighted = INGESTION_STEP_ORDER.reduce((sum, name) => {
    const step = byName.get(name);
    if (!step) return sum;
    const stagePercent =
      step.status === 'SUCCEEDED'
        ? 100
        : (step.stagePercent ??
          calculateStagePercent(step.processedUnits, step.totalUnits, step.status) ??
          0);
    return sum + (INGESTION_STEP_WEIGHTS[name] * stagePercent) / 100;
  }, 0);
  return roundPercent(Math.min(100, weighted));
}

/** 百分比保留两位，避免同一事实因浮点尾数造成 ETag 抖动。 */
function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}
