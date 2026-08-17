<script setup lang="ts">
/** M03 面板组合器：管理请求状态与运行选择，把纯展示事实下发给子组件。 */
import { computed } from 'vue';
import { useParseRuns } from '../composables/useParseRuns';
import BlockPreviewTable from './BlockPreviewTable.vue';
import ParseRunSummary from './ParseRunSummary.vue';
import SecurityFindingList from './SecurityFindingList.vue';

const props = defineProps<{ documentVersionId: string }>();
const parsing = useParseRuns(() => props.documentVersionId);
const selectedRunId = computed({
  get: () => parsing.selectedRun.value?.id ?? '',
  set: (id: string) => {
    const run = parsing.runs.value.find((candidate) => candidate.id === id);
    if (run) void parsing.selectRun(run);
  },
});
</script>

<template>
  <section class="parse-panel">
    <header class="panel-heading">
      <div>
        <span>M03 / PARSING EVIDENCE</span>
        <h4>文件安全与结构解析</h4>
      </div>
      <ElSelect
        v-if="parsing.runs.value.length > 1"
        v-model="selectedRunId"
        size="small"
        aria-label="选择解析运行"
      >
        <ElOption
          v-for="run in parsing.runs.value"
          :key="run.id"
          :value="run.id"
          :label="`r${run.contentRevision} · ${run.status}`"
        />
      </ElSelect>
    </header>

    <ElAlert
      v-if="parsing.errorMessage.value"
      :title="parsing.errorMessage.value"
      type="error"
      :closable="false"
      show-icon
    >
      <ElButton text type="danger" @click="parsing.reload">重试</ElButton>
    </ElAlert>
    <ElSkeleton v-else-if="parsing.loading.value" :rows="4" animated />
    <template v-else-if="parsing.selectedRun.value">
      <ParseRunSummary :run="parsing.selectedRun.value" />
      <SecurityFindingList :issues="parsing.issues.value" />
      <BlockPreviewTable
        :blocks="parsing.blocks.value"
        :loading-more="parsing.loadingMore.value"
        :has-more="parsing.nextOrdinal.value !== null"
        @load-more="parsing.loadMore"
        @retry="parsing.reload"
      />
    </template>
    <ElEmpty v-else :image-size="48" description="M03 尚未生成解析运行" />
  </section>
</template>

<style scoped>
.parse-panel {
  padding: 18px 20px;
  border-top: 1px solid var(--line-strong);
  background: #f1ede4;
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
