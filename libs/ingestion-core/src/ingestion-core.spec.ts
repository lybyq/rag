/** M02 领域规则测试：状态机、真实进度、稳定标识与文件名净化。 */
import {
  IllegalIngestionTransitionError,
  calculateOverallPercent,
  calculateStagePercent,
  createIngestionJobId,
  createIngestionStepId,
  createIsolatedObjectKey,
  sanitizeOriginalFileName,
  assertDocumentVersionTransition,
  assertJobTransition,
} from '.';

describe('M02 ingestion core', () => {
  it('拒绝终态任务直接回到 RUNNING', () => {
    expect(() => assertJobTransition('SUCCEEDED', 'RUNNING')).toThrow(
      IllegalIngestionTransitionError,
    );
  });

  it('允许失败版本通过新修订重新排队', () => {
    expect(() => assertDocumentVersionTransition('FAILED', 'QUEUED')).not.toThrow();
  });

  it('总量未知时不伪造阶段百分比', () => {
    expect(calculateStagePercent(3, null, 'RUNNING')).toBeNull();
  });

  it('总体进度按真实权重计算', () => {
    const progress = calculateOverallPercent([
      {
        name: 'SECURITY_SCAN',
        status: 'SUCCEEDED',
        processedUnits: 1,
        totalUnits: 1,
        stagePercent: 100,
      },
      {
        name: 'PARSE',
        status: 'RUNNING',
        processedUnits: 1,
        totalUnits: 2,
        stagePercent: 50,
      },
    ]);
    expect(progress).toBe(18);
  });

  it('稳定 ID 包含版本、修订、步骤与实现版本', () => {
    const versionId = '0198a8f4-12f8-7000-8000-111111111111';
    expect(createIngestionJobId(versionId, 2, 1)).toContain('revision:2:pipeline:v1');
    expect(createIngestionStepId(versionId, 2, 'PARSE', 3)).toContain('step:PARSE:v3');
  });

  it('对象路径不包含恶意文件名', () => {
    const key = createIsolatedObjectKey('space-id', 'upload-id', 'file-id');
    expect(key).toBe('spaces/space-id/uploads/upload-id/files/file-id');
    expect(sanitizeOriginalFileName('../../工资\u0000表?.pdf')).toBe('工资表_.pdf');
  });
});
