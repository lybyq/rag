<!-- 评测集、异步运行、基线差异、指标方差与失败样本。 @requirement WEB-023 WEB-027 -->
<script setup lang="ts">
/* eslint-disable vue/html-indent, vue/multiline-html-element-content-newline -- 表格模板遵循 Prettier。 */
import { computed, ref } from 'vue';
import { useEvaluationCenter } from '../composables/useOperationsConsole';
const state = useEvaluationCenter();
const selectedDatasetId = ref('');
const detailOpen = computed({
  get: () => Boolean(state.detail.value),
  set: (value) => {
    if (!value) state.detail.value = undefined;
  },
});
const metricLabel: Record<string, string> = {
  ANSWERABLE_RECALL_AT_40: 'Recall@40',
  HIT_AT_5: 'Hit@5',
  CITATION_PRECISION: '引用准确率',
  UNSUPPORTED_CLAIM_RATE: '无支撑 Claim',
  REFUSAL_ACCURACY: '拒答准确率',
  VERSION_SCOPE_ACCURACY: '版本范围准确率',
  PERMISSION_LEAK_RATE: '权限泄漏率',
  PARSING_ACCURACY: '解析准确率',
  CHUNK_BOUNDARY_ACCURACY: 'Chunk 边界',
  SECURITY_PASS_RATE: '安全通过率',
  LATENCY_PASS_RATE: '延迟通过率',
};
/** 把最近完成 Run 展开成可排序趋势事实，不在浏览器重算评分或 Baseline。 */
const trendRows = computed(() =>
  state.runs.value
    .filter((run) => run.status === 'COMPLETED')
    .flatMap((run) =>
      run.metrics.map((metric) => ({
        runId: run.id,
        datasetVersion: run.datasetVersion,
        completedAt: run.completedAt,
        name: metric.name,
        value: metric.value,
        variance: metric.variance,
        passed: metric.passed,
      })),
    )
    .slice(0, 200),
);
</script>

<template>
  <section class="evaluation-center">
    <ElAlert
      v-if="state.errorMessage.value"
      :title="state.errorMessage.value"
      type="error"
      :closable="false"
    >
      <template #default><ElButton text @click="state.load">重试</ElButton></template>
    </ElAlert>
    <div class="evaluation-toolbar">
      <div>
        <span>GOLDEN REGRESSION</span>
        <h2>版本化评测中心</h2>
      </div>
      <div class="run-command">
        <ElSelect v-model="selectedDatasetId" placeholder="选择评测集" aria-label="选择评测集">
          <ElOption
            v-for="dataset in state.datasets.value"
            :key="dataset.id"
            :label="`${dataset.name} · ${dataset.version}`"
            :value="dataset.id"
            :disabled="dataset.status !== 'ACTIVE'"
          />
        </ElSelect>
        <ElButton
          type="primary"
          :disabled="!selectedDatasetId"
          :loading="state.mutating.value"
          @click="state.run(selectedDatasetId)"
        >
          执行真实评测
        </ElButton>
      </div>
    </div>

    <ElTabs>
      <ElTabPane label="数据集版本">
        <ElTable
          v-loading="state.loading.value"
          :data="[...state.datasets.value]"
          empty-text="尚无评测集；可通过 API/导入流程创建 Golden Set"
        >
          <ElTableColumn prop="name" label="名称" min-width="180" />
          <ElTableColumn prop="version" label="版本" width="120" />
          <ElTableColumn prop="caseCount" label="Case" width="90" />
          <ElTableColumn prop="status" label="状态" width="120">
            <template #default="{ row }">
              <ElTag effect="plain" :type="row.status === 'ACTIVE' ? 'success' : 'info'">
                {{ row.status }}
              </ElTag>
            </template>
          </ElTableColumn>
          <ElTableColumn prop="createdBy" label="创建人" min-width="150" />
          <ElTableColumn label="操作" width="110">
            <template #default="{ row }">
              <ElButton
                v-if="row.status === 'DRAFT'"
                text
                type="primary"
                @click="state.activate(row.id)"
              >
                激活版本
              </ElButton>
            </template>
          </ElTableColumn>
        </ElTable>
      </ElTabPane>
      <ElTabPane label="评测运行">
        <ElTable
          v-loading="state.loading.value"
          :data="[...state.runs.value]"
          empty-text="尚未执行评测"
        >
          <ElTableColumn prop="datasetName" label="数据集" min-width="180" />
          <ElTableColumn prop="datasetVersion" label="版本" width="100" />
          <ElTableColumn prop="status" label="状态" width="120">
            <template #default="{ row }">
              <ElTag
                effect="plain"
                :type="
                  row.status === 'COMPLETED'
                    ? 'success'
                    : row.status === 'FAILED'
                      ? 'danger'
                      : 'warning'
                "
              >
                {{ row.status }}
              </ElTag>
            </template>
          </ElTableColumn>
          <ElTableColumn label="进度" min-width="180">
            <template #default="{ row }">
              <ElProgress
                :percentage="
                  row.totalCases ? Math.round((row.completedCases / row.totalCases) * 100) : 0
                "
              />
            </template>
          </ElTableColumn>
          <ElTableColumn label="通过" width="100">
            <template #default="{ row }"> {{ row.passedCases }}/{{ row.completedCases }} </template>
          </ElTableColumn>
          <ElTableColumn label="操作" width="100">
            <template #default="{ row }">
              <ElButton text type="primary" @click="state.inspect(row.id)"> 下钻 </ElButton>
            </template>
          </ElTableColumn>
        </ElTable>
      </ElTabPane>
      <ElTabPane label="指标趋势">
        <ElTable :data="trendRows" empty-text="完成至少一次评测后显示指标趋势">
          <ElTableColumn prop="datasetVersion" label="数据集版本" min-width="130" />
          <ElTableColumn label="指标" min-width="180">
            <template #default="{ row }">
              {{ metricLabel[row.name] ?? row.name }}
            </template> </ElTableColumn
          ><ElTableColumn label="结果" width="110">
            <template #default="{ row }">
              <ElTag :type="row.passed ? 'success' : 'danger'" effect="plain">
                {{ (row.value * 100).toFixed(2) }}%
              </ElTag>
            </template> </ElTableColumn
          ><ElTableColumn label="方差" width="110">
            <template #default="{ row }">{{ row.variance.toFixed(4) }}</template> </ElTableColumn
          ><ElTableColumn prop="completedAt" label="完成时间" min-width="180" />
          <ElTableColumn prop="runId" label="Run" min-width="220" />
        </ElTable>
      </ElTabPane>
    </ElTabs>

    <ElDrawer v-model="detailOpen" title="评测运行详情" size="72%" destroy-on-close>
      <template v-if="state.detail.value">
        <div class="metric-grid">
          <article
            v-for="metric in state.detail.value.run.metrics"
            :key="metric.name"
            :class="{ failed: !metric.passed }"
          >
            <span>{{ metricLabel[metric.name] ?? metric.name }}</span>
            <strong>{{ (metric.value * 100).toFixed(2) }}%</strong>
            <small
              >阈值 {{ metric.comparator }} {{ (metric.threshold * 100).toFixed(2) }}% · 方差
              {{ metric.variance.toFixed(4) }}</small
            >
          </article>
        </div>
        <ElAlert
          v-for="regression in state.detail.value.regressions"
          :key="regression"
          :title="regression"
          type="error"
          show-icon
          :closable="false"
        />
        <h3>失败样本</h3>
        <ElTable
          :data="state.detail.value.results.filter((item) => item.status !== 'PASSED')"
          empty-text="没有失败样本"
        >
          <ElTableColumn prop="caseId" label="Case ID" min-width="220" />
          <ElTableColumn prop="status" label="状态" width="100" />
          <ElTableColumn label="失败码" min-width="240">
            <template #default="{ row }">
              {{ row.failureCodes.join(', ') || '—' }}
            </template>
          </ElTableColumn>
          <ElTableColumn prop="durationMs" label="耗时(ms)" width="120" />
        </ElTable>
      </template>
    </ElDrawer>
  </section>
</template>

<style scoped>
.evaluation-center {
  padding: 24px;
  border: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
}
.evaluation-toolbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 20px;
}
.evaluation-toolbar span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
}
.evaluation-toolbar h2 {
  margin: 5px 0 0;
  font-family: var(--font-editorial);
}
.run-command {
  min-width: 390px;
  display: flex;
  gap: 9px;
}
.run-command :deep(.el-select) {
  flex: 1;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 18px;
}
.metric-grid article {
  display: grid;
  gap: 7px;
  padding: 16px;
  border: 1px solid var(--line-subtle);
}
.metric-grid article.failed {
  border-color: var(--danger-400);
}
.metric-grid span {
  color: var(--text-secondary);
  font-size: 11px;
}
.metric-grid strong {
  font-family: var(--font-editorial);
  font-size: 25px;
}
.metric-grid small {
  color: var(--text-tertiary);
}
@media (max-width: 900px) {
  .evaluation-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .run-command {
    min-width: 0;
  }
  .metric-grid {
    grid-template-columns: 1fr;
  }
}
</style>
