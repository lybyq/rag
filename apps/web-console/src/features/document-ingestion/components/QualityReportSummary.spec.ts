/** M04 质量摘要黑盒组件测试。 @requirement KNO-011 @requirement KNO-012 */
import type { DocumentQualityReport, KnowledgeProcessingRun, QualityFinding } from '@rag/contracts';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import QualityReportSummary from './QualityReportSummary.vue';

const now = '2026-08-18T00:00:00.000Z';
const run: KnowledgeProcessingRun = {
  id: '33333333-3333-4333-8333-333333333333',
  jobId: 'job-1',
  parseRunId: '11111111-1111-4111-8111-111111111111',
  documentVersionId: '22222222-2222-4222-8222-222222222222',
  contentRevision: 2,
  fileFormat: 'PDF',
  status: 'WAITING',
  chunkerProfileId: 'structure-aware-medium-v1',
  chunkerRevision: '1.0.0',
  tokenizerProfileId: 'cl100k-base-local',
  tokenizerRevision: 'js-tiktoken-1.0.21:cl100k_base',
  qualityRuleVersion: 'quality-medium-v1',
  parentChunkCount: 3,
  childChunkCount: 8,
  relationCount: 29,
  failureCode: null,
  failureMessage: null,
  metrics: {},
  startedAt: now,
  completedAt: now,
  createdAt: now,
  updatedAt: now,
};

const report: DocumentQualityReport = {
  id: '44444444-4444-4444-8444-444444444444',
  processingRunId: run.id,
  documentVersionId: run.documentVersionId,
  contentRevision: 2,
  verdict: 'MANUAL_REVIEW',
  ruleVersion: 'quality-medium-v1',
  metrics: {
    expectedPageCount: 10,
    observedPageCount: 9,
    nonEmptyBlockRatio: 0.96,
    averageOcrConfidence: 0.68,
    garbledCharacterRatio: 0.001,
    duplicateChildRatio: 0.125,
    tableCount: 1,
    malformedTableCount: 0,
    headingCount: 4,
    childChunkCount: 8,
    suppressedDuplicateCount: 1,
    missingPageNos: [7],
    hasResponsibleOwner: true,
    versionConsistent: true,
  },
  reviewDecision: 'PENDING',
  reviewReason: null,
  reviewedBy: null,
  reviewedAt: null,
  optimisticVersion: 1,
  eligibleForIndex: false,
  createdAt: now,
  updatedAt: now,
};

const findings: QualityFinding[] = [
  {
    id: '55555555-5555-4555-8555-555555555555',
    reportId: report.id,
    severity: 'WARNING',
    code: 'QUALITY_MISSING_PAGES',
    message: '解析结果存在缺失页',
    pageNos: [7],
    blockIds: [],
    chunkIds: [],
    metadata: {},
    createdAt: now,
  },
];

describe('QualityReportSummary', () => {
  it('[KNO-011] 展示真实质量指标、发现代码和 Tokenizer revision', () => {
    const wrapper = mount(QualityReportSummary, {
      props: { run, report, findings },
      global: { stubs: { ElButton: { template: '<button><slot /></button>' } } },
    });

    expect(wrapper.get('[data-testid="quality-verdict"]').text()).toBe('需要复核');
    expect(wrapper.text()).toContain('96.0%');
    expect(wrapper.text()).toContain('QUALITY_MISSING_PAGES');
    expect(wrapper.text()).toContain('js-tiktoken-1.0.21:cl100k_base');
  });

  it('[KNO-012] 用户点击审核入口时只向上发出 review 事件', async () => {
    const wrapper = mount(QualityReportSummary, {
      props: { run, report, findings },
      global: {
        stubs: {
          ElButton: {
            inheritAttrs: false,
            template:
              '<button data-testid="open-quality-review" @click="$emit(\'click\')"><slot /></button>',
          },
        },
      },
    });

    await wrapper.get('[data-testid="open-quality-review"]').trigger('click');
    expect(wrapper.emitted('review')).toHaveLength(1);
  });
});
