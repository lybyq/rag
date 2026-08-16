<script setup lang="ts">
/** 任务列表、过滤和详情编排。 */
import type { IngestionExecutionStatus, IngestionJob, KnowledgeSpace } from '@rag/contracts';
import { ElMessage, ElMessageBox } from 'element-plus/es';
import { useIngestionJobs } from '../composables/useIngestionJobs';
import JobDetailDrawer from './JobDetailDrawer.vue';

defineProps<{ spaces: readonly KnowledgeSpace[] }>();
const jobs = useIngestionJobs();
const statuses: readonly IngestionExecutionStatus[] = [
  'QUEUED',
  'RUNNING',
  'WAITING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REJECTED',
];

function tagType(
  status: IngestionExecutionStatus,
): 'info' | 'primary' | 'warning' | 'success' | 'danger' {
  if (status === 'SUCCEEDED') return 'success';
  if (['FAILED', 'REJECTED'].includes(status)) return 'danger';
  if (status === 'WAITING') return 'warning';
  if (status === 'RUNNING') return 'primary';
  return 'info';
}

async function cancel(job: IngestionJob): Promise<void> {
  const result = await ElMessageBox.prompt(
    '取消会传播到后续 Worker，请填写审计原因。',
    '取消任务',
    {
      confirmButtonText: '确认取消',
      cancelButtonText: '返回',
      inputPattern: /^.{2,300}$/,
      inputErrorMessage: '原因需为 2～300 个字符',
      type: 'warning',
    },
  ).catch(() => undefined);
  const reason =
    result && typeof result === 'object' && 'value' in result ? String(result.value) : '';
  if (!reason) return;
  await jobs.cancel(job.id, reason);
  ElMessage.success('任务已取消');
}
</script>

<template>
  <section class="job-center" :class="{ 'has-detail': jobs.selectedJob.value }">
    <div class="job-list-pane">
      <header class="task-toolbar">
        <div>
          <span>PIPELINE CONTROL</span>
          <h2>入库任务</h2>
        </div>
        <div class="filters">
          <ElSelect
            v-model="jobs.filters.spaceId"
            clearable
            placeholder="全部空间"
            @change="jobs.load"
          >
            <ElOption
              v-for="space in spaces"
              :key="space.id"
              :label="space.name"
              :value="space.id"
            />
          </ElSelect>
          <ElSelect
            v-model="jobs.filters.status"
            clearable
            placeholder="全部状态"
            @change="jobs.load"
          >
            <ElOption v-for="status in statuses" :key="status" :label="status" :value="status" />
          </ElSelect>
          <ElButton :loading="jobs.loading.value" @click="jobs.load">刷新</ElButton>
        </div>
      </header>

      <ElAlert
        v-if="jobs.errorMessage.value"
        :title="jobs.errorMessage.value"
        type="error"
        show-icon
        :closable="false"
      />
      <ElTable
        v-loading="jobs.loading.value"
        :data="[...jobs.jobs.value]"
        row-key="id"
        empty-text="暂无入库任务"
        @row-click="jobs.select"
      >
        <ElTableColumn label="状态" width="112">
          <template #default="scope">
            <ElTag :type="tagType(scope.row.status)" effect="plain" size="small">
              {{ scope.row.status }}
            </ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn label="当前步骤" min-width="150">
          <template #default="scope">
            <strong class="step-name">{{ scope.row.currentStep ?? '—' }}</strong>
            <small>{{ scope.row.publicMessage ?? '等待状态更新' }}</small>
          </template>
        </ElTableColumn>
        <ElTableColumn label="真实进度" min-width="180">
          <template #default="scope">
            <ElProgress :percentage="scope.row.overallPercent" :stroke-width="5" />
          </template>
        </ElTableColumn>
        <ElTableColumn prop="contentRevision" label="修订" width="72" />
        <ElTableColumn prop="attempt" label="尝试" width="72" />
        <ElTableColumn label="更新时间" width="152">
          <template #default="scope">
            <time>{{ new Date(scope.row.updatedAt).toLocaleString() }}</time>
          </template>
        </ElTableColumn>
      </ElTable>
    </div>

    <JobDetailDrawer
      :job="jobs.selectedJob.value"
      :events="jobs.events.value"
      @close="jobs.closeDetail"
      @cancel="cancel"
    />
  </section>
</template>

<style scoped>
.job-center {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  margin-top: 22px;
  overflow: hidden;
  background: var(--surface-elevated);
  border: 1px solid var(--line-strong);
}
.job-center.has-detail {
  grid-template-columns: minmax(620px, 1fr) minmax(360px, 430px);
}
.job-list-pane {
  min-width: 0;
}
.task-toolbar {
  min-height: 82px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 16px 22px;
  border-bottom: 1px solid var(--line-subtle);
}
.task-toolbar span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.13em;
}
.task-toolbar h2 {
  margin: 4px 0 0;
  font-family: var(--font-editorial);
  font-size: 20px;
}
.filters {
  display: flex;
  gap: 8px;
}
.filters :deep(.el-select) {
  width: 150px;
}
.step-name,
.step-name + small {
  display: block;
}
.step-name {
  font-family: var(--font-mono);
  font-size: 10px;
}
.step-name + small,
time {
  margin-top: 4px;
  color: var(--text-tertiary);
  font-size: 9px;
}
:deep(.el-table__row) {
  cursor: pointer;
}
@media (max-width: 1320px) {
  .job-center.has-detail {
    grid-template-columns: 1fr;
  }
  .job-center.has-detail :deep(.job-drawer) {
    border-top: 1px solid var(--line-strong);
    border-left: 0;
  }
}
@media (max-width: 720px) {
  .task-toolbar,
  .filters {
    align-items: stretch;
    flex-direction: column;
  }
  .filters :deep(.el-select) {
    width: 100%;
  }
}
</style>
