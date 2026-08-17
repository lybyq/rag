<script setup lang="ts">
/**
 * M04 质量报告展示组件：只呈现服务端自动结论、审核状态、指标和发现项。
 * 审核按钮只发出事件，不在组件内调用 API 或推测权限。
 */
import type { DocumentQualityReport, KnowledgeProcessingRun, QualityFinding } from '@rag/contracts';
import { computed } from 'vue';

const props = defineProps<{
  run: KnowledgeProcessingRun;
  report: DocumentQualityReport;
  findings: readonly QualityFinding[];
}>();
const emit = defineEmits<{ review: [] }>();

const verdictLabel = computed(() => {
  if (props.report.verdict === 'PASS') return '自动通过';
  if (props.report.verdict === 'MANUAL_REVIEW') return '需要复核';
  return '质量拒绝';
});
const canReview = computed(
  () => props.report.reviewDecision === 'PENDING' && props.report.verdict !== 'PASS',
);
const decisionLabel = computed(
  () =>
    ({
      NOT_REQUIRED: '无需人工审核',
      PENDING: '等待审核',
      APPROVED: '人工已批准',
      REJECTED: '人工已拒绝',
      REPROCESS_REQUESTED: '已要求重处理',
    })[props.report.reviewDecision],
);
</script>

<template>
  <section class="quality-report" aria-label="文档质量报告">
    <div class="verdict-rail" :class="`verdict-${report.verdict.toLowerCase()}`">
      <small>QUALITY GATE</small>
      <strong data-testid="quality-verdict">{{ verdictLabel }}</strong>
      <span>{{ decisionLabel }}</span>
      <ElButton
        v-if="canReview"
        data-testid="open-quality-review"
        type="warning"
        size="small"
        plain
        @click="emit('review')"
      >
        进入审核
      </ElButton>
    </div>

    <div class="quality-body">
      <dl class="metric-grid">
        <div>
          <dt>Child</dt>
          <dd>{{ report.metrics.childChunkCount }}</dd>
          <small>Parent {{ run.parentChunkCount }}</small>
        </div>
        <div>
          <dt>覆盖率</dt>
          <dd>{{ (report.metrics.nonEmptyBlockRatio * 100).toFixed(1) }}%</dd>
          <small>
            {{ report.metrics.observedPageCount }}/{{ report.metrics.expectedPageCount }} 页
          </small>
        </div>
        <div>
          <dt>OCR</dt>
          <dd>{{ report.metrics.averageOcrConfidence?.toFixed(2) ?? '—' }}</dd>
          <small>平均置信度</small>
        </div>
        <div>
          <dt>重复</dt>
          <dd>{{ (report.metrics.duplicateChildRatio * 100).toFixed(1) }}%</dd>
          <small>抑制 {{ report.metrics.suppressedDuplicateCount }}</small>
        </div>
        <div>
          <dt>Tokenizer</dt>
          <dd>{{ run.tokenizerProfileId }}</dd>
          <small>{{ run.tokenizerRevision }}</small>
        </div>
        <div>
          <dt>Rule</dt>
          <dd>{{ report.ruleVersion }}</dd>
          <small>v{{ report.optimisticVersion }} · r{{ run.contentRevision }}</small>
        </div>
      </dl>

      <div v-if="findings.length" class="finding-list" aria-label="质量发现项">
        <article
          v-for="finding in findings"
          :key="finding.id"
          :class="`severity-${finding.severity.toLowerCase()}`"
        >
          <div>
            <code>{{ finding.code }}</code>
            <strong>{{ finding.message }}</strong>
          </div>
          <span v-if="finding.pageNos.length">P{{ finding.pageNos.join(', P') }}</span>
        </article>
      </div>
      <p v-else class="clean-note">所有自动质量规则均已通过，没有发现需要展示的问题。</p>
    </div>
  </section>
</template>

<style scoped>
.quality-report {
  display: grid;
  grid-template-columns: 142px minmax(0, 1fr);
  border: 1px solid var(--line-strong);
  background: #fffdf8;
}
.verdict-rail {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  padding: 16px;
  border-right: 1px solid var(--line-strong);
}
.verdict-rail small,
.metric-grid dt {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 8px;
  letter-spacing: 0.1em;
}
.verdict-rail strong {
  font-family: var(--font-editorial);
  font-size: 18px;
}
.verdict-rail span {
  color: var(--text-secondary);
  font-size: 10px;
}
.verdict-pass {
  box-shadow: inset 4px 0 #315d48;
}
.verdict-manual_review {
  box-shadow: inset 4px 0 #bd7b1e;
}
.verdict-reject {
  box-shadow: inset 4px 0 #a7463c;
}
.quality-body {
  min-width: 0;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
}
.metric-grid div {
  min-width: 0;
  padding: 10px 12px;
  border-right: 1px solid var(--line-subtle);
  border-bottom: 1px solid var(--line-subtle);
}
.metric-grid dd {
  overflow: hidden;
  margin: 4px 0 2px;
  font-size: 11px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.metric-grid small {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 8px;
}
.finding-list {
  padding: 8px 12px 12px;
}
.finding-list article {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line-subtle);
}
.finding-list article div {
  display: grid;
  gap: 3px;
}
.finding-list code,
.finding-list span {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 8px;
}
.finding-list strong {
  font-size: 10px;
}
.severity-error {
  box-shadow: inset 2px 0 #a7463c;
  padding-left: 8px !important;
}
.severity-warning {
  box-shadow: inset 2px 0 #bd7b1e;
  padding-left: 8px !important;
}
.clean-note {
  margin: 0;
  padding: 12px;
  color: #315d48;
  font-size: 10px;
}
@media (max-width: 920px) {
  .quality-report {
    grid-template-columns: 1fr;
  }
  .verdict-rail {
    border-right: 0;
    border-bottom: 1px solid var(--line-strong);
  }
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
