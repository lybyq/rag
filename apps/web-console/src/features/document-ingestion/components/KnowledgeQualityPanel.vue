<script setup lang="ts">
/** M04 面板组合器：管理运行选择和审核弹窗，把展示与副作用下沉到专用组件/composable。 */
import type { QualityReviewAction } from '@rag/contracts';
import { computed, shallowRef } from 'vue';
import { useKnowledgeProcessing } from '../composables/useKnowledgeProcessing';
import KnowledgeChunkTable from './KnowledgeChunkTable.vue';
import QualityReportSummary from './QualityReportSummary.vue';
import QualityReviewDialog from './QualityReviewDialog.vue';

const props = defineProps<{ documentVersionId: string }>();
const processing = useKnowledgeProcessing(() => props.documentVersionId);
const reviewOpen = shallowRef(false);
const selectedRunId = computed({
  get: () => processing.selectedRun.value?.id ?? '',
  set: (id: string) => {
    const run = processing.runs.value.find((candidate) => candidate.id === id);
    if (run) void processing.selectRun(run);
  },
});

async function submitReview(request: {
  action: QualityReviewAction;
  expectedVersion: number;
  reason: string;
}): Promise<void> {
  if (await processing.submitReview(request)) reviewOpen.value = false;
}
</script>

<template>
  <section class="knowledge-panel">
    <header class="panel-heading">
      <div>
        <span>M04 / KNOWLEDGE QUALITY</span>
        <h4>结构切块与质量审核</h4>
      </div>
      <ElSelect
        v-if="processing.runs.value.length > 1"
        v-model="selectedRunId"
        size="small"
        aria-label="选择知识加工运行"
      >
        <ElOption
          v-for="run in processing.runs.value"
          :key="run.id"
          :value="run.id"
          :label="`r${run.contentRevision} · ${run.status}`"
        />
      </ElSelect>
    </header>

    <ElAlert
      v-if="processing.errorMessage.value"
      :title="processing.errorMessage.value"
      type="error"
      :closable="false"
      show-icon
    >
      <ElButton text type="danger" @click="processing.reload">重试</ElButton>
    </ElAlert>
    <ElSkeleton v-else-if="processing.loading.value" :rows="5" animated />
    <template v-else-if="processing.selectedRun.value && processing.report.value">
      <QualityReportSummary
        :run="processing.selectedRun.value"
        :report="processing.report.value"
        :findings="processing.findings.value"
        @review="reviewOpen = true"
      />
      <KnowledgeChunkTable
        :chunks="processing.chunks.value"
        :loading-more="processing.loadingMore.value"
        :has-more="processing.nextOrdinal.value !== null"
        @load-more="processing.loadMore"
      />
      <QualityReviewDialog
        v-model:open="reviewOpen"
        :report="processing.report.value"
        :submitting="processing.submittingReview.value"
        :error-message="processing.reviewErrorMessage.value"
        @submit="submitReview"
      />
    </template>
    <ElEmpty v-else :image-size="48" description="M04 尚未生成知识加工运行" />
  </section>
</template>

<style scoped>
.knowledge-panel {
  padding: 18px 20px;
  border-top: 1px solid var(--line-strong);
  background: #e9e3d7;
}
.panel-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 12px;
}
.panel-heading span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 8px;
  letter-spacing: 0.12em;
}
.panel-heading h4 {
  margin: 3px 0 0;
  font-family: var(--font-editorial);
  font-size: 16px;
}
</style>
