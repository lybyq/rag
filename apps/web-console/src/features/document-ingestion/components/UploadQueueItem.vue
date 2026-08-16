<script setup lang="ts">
/** 单文件上传状态行；所有副作用通过 emits 交给父级 Composable。 */
import type { UploadQueueEntry } from '../composables/useDocumentUpload';

const props = defineProps<{ entry: UploadQueueEntry; busy: boolean }>();
const emit = defineEmits<{
  remove: [clientFileId: string];
  retry: [clientFileId: string];
  cancel: [clientFileId: string];
}>();

const statusTone: Record<
  UploadQueueEntry['status'],
  'info' | 'primary' | 'warning' | 'success' | 'danger'
> = {
  READY: 'info',
  PREPARING: 'primary',
  UPLOADING: 'primary',
  VERIFYING: 'warning',
  QUEUED: 'success',
  FAILED: 'danger',
  CANCELLED: 'info',
  NEEDS_FILE: 'warning',
};
const statusLabel: Record<UploadQueueEntry['status'], string> = {
  READY: '等待',
  PREPARING: '准备',
  UPLOADING: '直传中',
  VERIFYING: '校验中',
  QUEUED: '已入队',
  FAILED: '失败',
  CANCELLED: '已取消',
  NEEDS_FILE: '需重选文件',
};

function formatSize(bytes: number): string {
  if (bytes === 0) return '刷新恢复';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
</script>

<template>
  <article class="queue-item">
    <div class="file-mark">{{ entry.fileName.split('.').at(-1)?.slice(0, 4).toUpperCase() }}</div>
    <div class="file-state">
      <div class="file-heading">
        <strong :title="entry.fileName">{{ entry.fileName }}</strong>
        <span>{{ formatSize(entry.sizeBytes) }} · {{ entry.strategy ?? '待规划' }}</span>
      </div>
      <ElProgress
        :percentage="entry.progressPercent"
        :stroke-width="5"
        :show-text="false"
        :status="
          entry.status === 'FAILED'
            ? 'exception'
            : entry.status === 'QUEUED'
              ? 'success'
              : undefined
        "
      />
      <small>{{ entry.message }}</small>
    </div>
    <div class="queue-actions">
      <ElTag :type="statusTone[entry.status]" effect="plain" size="small">
        {{ statusLabel[entry.status] }}
      </ElTag>
      <ElButton
        v-if="entry.status === 'FAILED' && entry.file"
        link
        type="primary"
        @click="emit('retry', entry.clientFileId)"
      >
        重试
      </ElButton>
      <ElButton
        v-else-if="['UPLOADING', 'PREPARING'].includes(entry.status)"
        link
        @click="emit('cancel', entry.clientFileId)"
      >
        取消
      </ElButton>
      <ElButton
        v-else-if="entry.status === 'READY'"
        link
        :disabled="props.busy"
        @click="emit('remove', entry.clientFileId)"
      >
        移除
      </ElButton>
    </div>
  </article>
</template>

<style scoped>
.queue-item {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 13px 0;
  border-bottom: 1px solid var(--line-subtle);
}
.file-mark {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  color: var(--accent-700);
  background: var(--accent-050);
  border: 1px solid var(--accent-200);
  font-family: var(--font-mono);
  font-size: 9px;
}
.file-state {
  min-width: 0;
}
.file-heading {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 8px;
}
.file-heading strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-heading span,
.file-state small {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
.file-state small {
  display: block;
  margin-top: 6px;
}
.queue-actions {
  min-width: 76px;
  display: grid;
  justify-items: end;
  gap: 4px;
}
@media (max-width: 640px) {
  .queue-item {
    grid-template-columns: 38px minmax(0, 1fr);
  }
  .queue-actions {
    grid-column: 2;
    display: flex;
  }
}
</style>
