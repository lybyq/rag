<!-- 真实业务数量与质量趋势。 @requirement WEB-006 WEB-027 WEB-029 -->
<script setup lang="ts">
import { computed } from 'vue';
import { usePlatformOverview } from '../composables/useOperationsConsole';
const state = usePlatformOverview();
const cards = computed(() => {
  const value = state.overview.value;
  return value
    ? [
        ['知识空间', value.spaces],
        ['文档', value.documents],
        ['处理中', value.jobsRunning],
        ['失败任务', value.jobsFailed],
        ['待审核', value.pendingReviews],
        ['已发布', value.publishedDocuments],
        ['24h 问答', value.questions24h],
        ['回答成功率', `${(value.answerSuccessRate24h * 100).toFixed(1)}%`],
      ]
    : [];
});
</script>

<template>
  <div class="overview-panel">
    <ElAlert
      v-if="state.errorMessage.value"
      :title="state.errorMessage.value"
      type="error"
      :closable="false"
    >
      <template #default><ElButton text @click="state.load">重试</ElButton></template>
    </ElAlert>
    <ElSkeleton v-if="state.loading.value && !state.overview.value" :rows="8" animated />
    <template v-else-if="state.overview.value">
      <section class="metric-field">
        <article v-for="([label, value], index) in cards" :key="String(label)" class="metric-cell">
          <span>0{{ index + 1 }}</span
          ><strong>{{ value }}</strong
          ><small>{{ label }}</small>
        </article>
      </section>
      <section class="trend-sheet">
        <header>
          <div>
            <span>QUALITY TREND</span>
            <h2>近 14 日回答质量</h2>
          </div>
          <small>来自真实评测与问答事实</small>
        </header>
        <ElEmpty
          v-if="state.overview.value.qualityTrend.length === 0"
          description="尚无质量趋势；完成首个评测后会出现"
        />
        <div v-else class="trend-bars" role="img" aria-label="近十四日回答成功率和引用准确率趋势">
          <div
            v-for="point in state.overview.value.qualityTrend"
            :key="point.date"
            class="trend-column"
          >
            <div
              class="bar success"
              :style="{ height: `${Math.max(4, point.answerSuccessRate * 150)}px` }"
            />
            <div
              class="bar citation"
              :style="{ height: `${Math.max(4, (point.citationPrecision ?? 0) * 150)}px` }"
            />
            <small>{{ point.date.slice(5) }}</small>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.overview-panel {
  display: grid;
  gap: 20px;
}
.metric-field {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
}
.metric-cell {
  min-height: 128px;
  display: grid;
  align-content: center;
  padding: 20px 24px;
  border-right: 1px solid var(--line-subtle);
  border-bottom: 1px solid var(--line-subtle);
}
.metric-cell span {
  color: var(--accent-500);
  font-family: var(--font-mono);
  font-size: 9px;
}
.metric-cell strong {
  margin: 8px 0 3px;
  font-family: var(--font-editorial);
  font-size: 30px;
}
.metric-cell small {
  color: var(--text-secondary);
}
.trend-sheet {
  padding: 24px;
  border: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
}
.trend-sheet header {
  display: flex;
  align-items: end;
  justify-content: space-between;
}
.trend-sheet header span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
}
.trend-sheet h2 {
  margin: 5px 0 0;
  font-family: var(--font-editorial);
}
.trend-sheet header small {
  color: var(--text-tertiary);
}
.trend-bars {
  height: 190px;
  display: flex;
  align-items: end;
  gap: 15px;
  margin-top: 24px;
  padding: 0 10px;
  border-bottom: 1px solid var(--line-strong);
}
.trend-column {
  flex: 1;
  height: 180px;
  display: flex;
  align-items: end;
  justify-content: center;
  gap: 3px;
  position: relative;
  padding-bottom: 26px;
}
.trend-column small {
  position: absolute;
  bottom: 4px;
  font-family: var(--font-mono);
  font-size: 8px;
}
.bar {
  width: 10px;
  max-height: 150px;
}
.bar.success {
  background: var(--ink-900);
}
.bar.citation {
  background: var(--accent-500);
}
@media (max-width: 900px) {
  .metric-field {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
