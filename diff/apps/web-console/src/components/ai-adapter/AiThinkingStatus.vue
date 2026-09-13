<!-- 只展示服务端公开阶段，不展示模型私有思维链。 @requirement WEB-003 WEB-019 -->
<script setup lang="ts">
import { computed } from 'vue';
import { Thinking } from 'vue-element-plus-x';

const props = defineProps<{
  stage: string;
  state: 'idle' | 'running' | 'completed' | 'error' | 'cancelled';
  timeline: readonly {
    sequence: number;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    message: string;
    occurredAt: string;
    durationMs?: number;
  }[];
  elapsedSeconds: number;
  slowNotice: boolean;
}>();
const status = computed(
  () =>
    ({
      idle: 'start',
      running: 'thinking',
      completed: 'end',
      error: 'error',
      cancelled: 'cancel',
    })[props.state] as 'start' | 'thinking' | 'end' | 'error' | 'cancel',
);
</script>

<template>
  <Thinking
    :content="stage"
    :status="status"
    :model-value="state === 'running'"
    :auto-collapse="state !== 'running'"
    background-color="#f5f7fa"
    color="#475467"
  >
    <template #label>{{ stage }}</template>
    <template #content>
      <section class="processing-explanation" aria-label="真实处理说明时间线">
        <header>
          <strong>真实处理说明</strong>
          <span>已等待 {{ elapsedSeconds }} 秒</span>
        </header>
        <ol v-if="timeline.length">
          <li v-for="item in timeline" :key="item.sequence">
            <span :class="`status-dot status-${item.status.toLowerCase()}`" />
            <p>{{ item.message }}</p>
            <time>{{ new Date(item.occurredAt).toLocaleTimeString() }}</time>
          </li>
        </ol>
        <p v-else class="empty-status">{{ stage }}</p>
        <ElAlert
          v-if="slowNotice"
          title="本次等待较久，你可以取消运行。"
          type="warning"
          :closable="false"
          show-icon
        />
        <small>这里只展示后端可验证的处理事实，不展示或伪造模型私有思维链。</small>
      </section>
    </template>
  </Thinking>
</template>

<style scoped>
.processing-explanation {
  min-width: min(560px, 70vw);
  display: grid;
  gap: 10px;
}
.processing-explanation header,
.processing-explanation li {
  display: flex;
  align-items: center;
  gap: 9px;
}
.processing-explanation header {
  justify-content: space-between;
}
.processing-explanation header span,
.processing-explanation time,
.processing-explanation small {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
.processing-explanation ol {
  max-height: 180px;
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.processing-explanation li p,
.empty-status {
  flex: 1;
  margin: 0;
  color: var(--text-secondary);
  font-size: 11px;
}
.status-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--text-tertiary);
}
.status-completed {
  background: var(--success-500, #12b76a);
}
.status-running {
  background: var(--accent-500);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-500) 16%, transparent);
}
.status-failed {
  background: var(--danger-500, #f04438);
}
</style>
