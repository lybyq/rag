<script setup lang="ts">
/** 任务详情侧栏：只展示后端权重计算结果，未知总量显示不确定进度。 */
import type { IngestionJob, IngestionJobEvent } from '@rag/contracts';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import ParseInspectionPanel from './ParseInspectionPanel.vue';
import KnowledgeQualityPanel from './KnowledgeQualityPanel.vue';

const props = defineProps<{
  job?: IngestionJob;
  events: readonly IngestionJobEvent[];
  streamMode: 'idle' | 'connecting' | 'sse' | 'polling';
}>();
const emit = defineEmits<{
  close: [];
  cancel: [job: IngestionJob];
  reprocess: [job: IngestionJob];
}>();
const traceId = computed(() =>
  props.events
    .map((event) => event.data.traceId)
    .find((value): value is string => typeof value === 'string'),
);

const stepLabels: Record<string, string> = {
  SECURITY_SCAN: '文件安全检查',
  PARSE: '版面与文本解析',
  OCR: 'OCR 补充识别',
  NORMALIZE: '内容标准化',
  CHUNK: '知识切分',
  QUALITY_GATE: '质量门禁',
  EMBED: '向量生成',
  INDEX: '索引写入',
  VERIFY: '索引对账',
  PUBLISH: '原子发布',
};

function canCancel(job: IngestionJob): boolean {
  return ['QUEUED', 'RUNNING', 'WAITING'].includes(job.status);
}

/** 根据后端 UTC 时间戳显示真实耗时；运行中使用当前时刻仅用于展示 elapsed，不改变进度。 */
function stepDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return '尚未开始';
  const milliseconds = Math.max(
    0,
    new Date(finishedAt ?? new Date().toISOString()).getTime() - new Date(startedAt).getTime(),
  );
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}
</script>

<template>
  <aside v-if="job" class="job-drawer">
    <header>
      <div>
        <span>JOB INSPECTOR</span>
        <h3>任务执行链</h3>
      </div>
      <ElButton text aria-label="关闭详情" @click="emit('close')">关闭</ElButton>
    </header>

    <section class="job-summary">
      <div class="summary-percent">{{ job.overallPercent }}<small>%</small></div>
      <div>
        <strong>{{ job.status }}</strong>
        <p>{{ job.publicMessage ?? '等待处理状态更新' }}</p>
      </div>
    </section>
    <ElAlert
      v-if="streamMode === 'polling'"
      title="SSE 已断开，正在按事件游标和 ETag 轮询恢复；页面不会伪造进度。"
      type="warning"
      :closable="false"
    />
    <div v-else class="stream-badge">事件通道：{{ streamMode }}</div>

    <div class="step-list">
      <article v-for="step in job.steps" :key="step.id" class="step-row">
        <div class="step-index">{{ String(job.steps.indexOf(step) + 1).padStart(2, '0') }}</div>
        <div class="step-body">
          <div class="step-heading">
            <strong>{{ stepLabels[step.name] ?? step.name }}</strong>
            <ElTag size="small" effect="plain">{{ step.status }}</ElTag>
          </div>
          <ElProgress
            :percentage="step.stagePercent ?? 100"
            :indeterminate="step.stagePercent === null && step.status === 'RUNNING'"
            :show-text="step.stagePercent !== null"
            :stroke-width="4"
          />
          <small>
            权重 {{ step.weightPercent }}% ·
            {{
              step.totalUnits === null ? '总量未知' : `${step.processedUnits}/${step.totalUnits}`
            }}
            · 耗时 {{ stepDuration(step.startedAt, step.finishedAt) }}
          </small>
          <p v-if="step.publicMessage">{{ step.publicMessage }}</p>
        </div>
      </article>
    </div>

    <ParseInspectionPanel :document-version-id="job.documentVersionId" />
    <KnowledgeQualityPanel :document-version-id="job.documentVersionId" />

    <section class="event-log">
      <h4>事件续传记录</h4>
      <p v-if="traceId" class="trace-line">
        <span>TRACE</span><code>{{ traceId }}</code>
      </p>
      <div v-if="events.length">
        <p v-for="event in events" :key="event.id">
          <span>#{{ event.id }}</span
          ><strong>{{ event.eventType }}</strong>
          <time>{{ new Date(event.occurredAt).toLocaleTimeString() }}</time>
        </p>
      </div>
      <ElEmpty v-else :image-size="46" description="等待事件" />
    </section>

    <footer>
      <ElButton v-if="canCancel(job)" type="danger" plain @click="emit('cancel', job)">
        取消任务
      </ElButton>
      <ElButton
        v-else-if="job.status === 'FAILED'"
        type="warning"
        plain
        @click="emit('reprocess', job)"
      >
        创建重处理任务
      </ElButton>
      <RouterLink v-if="['FAILED', 'REJECTED'].includes(job.status)" to="/operations">
        查看运维 Runbook
      </RouterLink>
      <code>{{ job.id }}</code>
    </footer>
  </aside>
</template>

<style scoped>
.job-drawer {
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #f8f5ee;
  border-left: 1px solid var(--line-strong);
}
.job-drawer > header {
  min-height: 82px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 17px 20px;
  background: var(--ink-950);
  color: #fff;
}
header span {
  color: var(--accent-400);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.13em;
}
header h3 {
  margin: 4px 0 0;
  font-family: var(--font-editorial);
  font-size: 19px;
}
.job-summary {
  display: grid;
  grid-template-columns: 90px 1fr;
  align-items: center;
  gap: 14px;
  padding: 20px;
  border-bottom: 1px solid var(--line-subtle);
}
.stream-badge {
  padding: 7px 20px;
  color: var(--text-tertiary);
  background: var(--surface-canvas);
  font-family: var(--font-mono);
  font-size: 9px;
}
.summary-percent {
  color: var(--accent-600);
  font-family: var(--font-editorial);
  font-size: 38px;
}
.summary-percent small {
  font-size: 15px;
}
.job-summary strong {
  font-family: var(--font-mono);
  font-size: 11px;
}
.job-summary p,
.step-body p {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 10px;
}
.step-list {
  max-height: 430px;
  overflow: auto;
  padding: 4px 20px;
}
.step-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 10px;
  padding: 14px 0;
  border-bottom: 1px solid var(--line-subtle);
}
.step-index {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
.step-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.step-heading strong {
  font-size: 11px;
}
.step-body small {
  display: block;
  margin-top: 6px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 8px;
}
.event-log {
  padding: 18px 20px;
  border-top: 1px solid var(--line-strong);
}
.event-log h4 {
  margin: 0 0 10px;
  font-family: var(--font-editorial);
}
.event-log p {
  display: grid;
  grid-template-columns: 35px 1fr auto;
  gap: 8px;
  margin: 6px 0;
  font-family: var(--font-mono);
  font-size: 8px;
}
.event-log p span,
.event-log time {
  color: var(--text-tertiary);
}
.job-drawer > footer {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px;
  border-top: 1px solid var(--line-subtle);
}
footer code {
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
