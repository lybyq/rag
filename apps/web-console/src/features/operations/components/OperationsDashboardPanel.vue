<!-- 服务/依赖、队列、DLQ、卡住任务、告警与授权动作。 @requirement WEB-025 WEB-027 -->
<script setup lang="ts">
/* eslint-disable vue/multiline-html-element-content-newline -- 运维表格模板遵循 Prettier。 */
import { useOperationsDashboard } from '../composables/useOperationsConsole';
const state = useOperationsDashboard();
function type(status: string): 'success' | 'warning' | 'danger' | 'info' {
  return status === 'UP'
    ? 'success'
    : status === 'DEGRADED' || status === 'UNKNOWN'
      ? 'warning'
      : status === 'DOWN'
        ? 'danger'
        : 'info';
}
</script>

<template>
  <section class="operations-dashboard">
    <ElAlert
      v-if="state.errorMessage.value"
      :title="state.errorMessage.value"
      type="error"
      :closable="false"
    >
      <template #default><ElButton text @click="state.load">重试</ElButton></template>
    </ElAlert>
    <ElSkeleton v-if="state.loading.value && !state.dashboard.value" :rows="10" animated />
    <template v-else-if="state.dashboard.value">
      <header class="ops-header">
        <div>
          <span>PRODUCTION CONTROL</span>
          <h2>运行健康与任务舱壁</h2>
        </div>
        <ElTag :type="type(state.dashboard.value.overallStatus)" effect="dark">
          {{ state.dashboard.value.overallStatus }}
        </ElTag>
      </header>
      <div class="component-grid">
        <article v-for="component in state.dashboard.value.components" :key="component.key">
          <div>
            <strong>{{ component.label }}</strong
            ><small>{{ component.kind }}</small>
          </div>
          <ElTag :type="type(component.status)" effect="plain">{{ component.status }}</ElTag>
          <p>{{ component.message }}</p>
          <small>{{
            component.latencyMs === null ? '无延迟样本' : `${component.latencyMs} ms`
          }}</small>
        </article>
      </div>
      <h3>队列与积压</h3>
      <ElTable :data="state.dashboard.value.queues" empty-text="没有队列指标">
        <ElTableColumn prop="queue" label="队列" min-width="180" /><ElTableColumn
          prop="waiting"
          label="等待"
          width="80"
        /><ElTableColumn prop="active" label="运行" width="80" /><ElTableColumn
          prop="stalled"
          label="卡住"
          width="80"
        /><ElTableColumn prop="failed" label="失败" width="80" /><ElTableColumn
          prop="dlq"
          label="DLQ"
          width="80"
        /><ElTableColumn prop="oldestWaitingSeconds" label="最老等待(s)" width="130" />
      </ElTable>
      <h3>索引对账结果</h3>
      <ElTable :data="state.dashboard.value.reconciliations" empty-text="尚无索引对账报告">
        <ElTableColumn label="结果" width="90">
          <template #default="{ row }">
            <ElTag :type="row.passed ? 'success' : 'danger'" effect="plain">
              {{ row.passed ? '通过' : '失败' }}
            </ElTag>
          </template> </ElTableColumn
        ><ElTableColumn prop="expectedCount" label="期望" width="90" /><ElTableColumn
          prop="actualCount"
          label="实际"
          width="90"
        /><ElTableColumn prop="checkedPrimaryKeys" label="主键检查" width="110" /><ElTableColumn
          prop="fixedQueriesPassed"
          label="固定查询"
          width="100"
        /><ElTableColumn prop="issueCount" label="问题" width="80" /><ElTableColumn
          prop="manifestId"
          label="Manifest"
          min-width="220"
        /><ElTableColumn prop="createdAt" label="对账时间" min-width="180" />
      </ElTable>
      <h3>可行动告警</h3>
      <ElTable :data="state.dashboard.value.alerts" empty-text="当前没有告警">
        <ElTableColumn prop="severity" label="级别" width="100" /><ElTableColumn
          prop="code"
          label="代码"
          min-width="150"
        /><ElTableColumn prop="title" label="标题" min-width="180" /><ElTableColumn
          prop="publicMessage"
          label="建议"
          min-width="260"
        /><ElTableColumn prop="runbookKey" label="Runbook" min-width="150" />
        <ElTableColumn label="处置" width="180">
          <template #default="{ row }">
            <ElButton v-if="row.status === 'OPEN'" text @click="state.act(row.id, 'ACKNOWLEDGE')">
              确认 </ElButton
            ><ElButton
              v-if="row.status !== 'RESOLVED'"
              text
              type="success"
              @click="state.act(row.id, 'RESOLVE')"
            >
              解决
            </ElButton>
          </template>
        </ElTableColumn>
      </ElTable>
    </template>
  </section>
</template>

<style scoped>
.operations-dashboard {
  padding: 24px;
  border: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
}
.ops-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.ops-header span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
}
.ops-header h2 {
  margin: 5px 0 0;
  font-family: var(--font-editorial);
}
.component-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.component-grid article {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 15px;
  border: 1px solid var(--line-subtle);
}
.component-grid strong,
.component-grid small {
  display: block;
}
.component-grid small {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
.component-grid p {
  grid-column: 1/-1;
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 11px;
}
h3 {
  margin-top: 28px;
  font-family: var(--font-editorial);
}
@media (max-width: 1000px) {
  .component-grid {
    grid-template-columns: 1fr;
  }
}
</style>
