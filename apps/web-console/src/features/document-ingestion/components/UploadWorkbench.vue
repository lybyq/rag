<script setup lang="ts">
/* global DragEvent, Event, HTMLInputElement */
/** 上传工作台：空间选择、拖放、浏览器直传队列和会话级取消。 */
import type { KnowledgeSpace } from '@rag/contracts';
import { ElMessage } from 'element-plus/es';
import { shallowRef, watch } from 'vue';
import { useDocumentUpload } from '../composables/useDocumentUpload';
import UploadQueueItem from './UploadQueueItem.vue';

defineProps<{ spaces: readonly KnowledgeSpace[] }>();
const emit = defineEmits<{ jobCreated: [jobId: string] }>();
const selectedSpaceId = defineModel<string>('spaceId', { default: '' });
const upload = useDocumentUpload();
const input = shallowRef<HTMLInputElement>();
const dragging = shallowRef(false);

watch(upload.lastCreatedJobId, (jobId) => {
  if (jobId) emit('jobCreated', jobId);
});

function onInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  if (target.files) upload.addFiles(target.files);
  target.value = '';
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  if (event.dataTransfer?.files) upload.addFiles(event.dataTransfer.files);
}

async function start(): Promise<void> {
  if (!selectedSpaceId.value) {
    ElMessage.warning('请先选择知识空间');
    return;
  }
  await upload.start(selectedSpaceId.value);
}
</script>

<template>
  <section class="upload-panel">
    <header class="panel-heading">
      <div>
        <span>DIRECT INGESTION</span>
        <h2>文档上传</h2>
      </div>
      <ElSelect v-model="selectedSpaceId" class="space-select" placeholder="选择知识空间">
        <ElOption
          v-for="space in spaces"
          :key="space.id"
          :label="`${space.name} · ${space.code}`"
          :value="space.id"
          :disabled="space.status !== 'ACTIVE' || !space.effectivePermissions.includes('WRITE')"
        />
      </ElSelect>
    </header>

    <button
      class="drop-zone"
      :class="{ 'is-dragging': dragging }"
      type="button"
      @click="input?.click()"
      @dragenter.prevent="dragging = true"
      @dragover.prevent
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <span class="upload-glyph">↑</span>
      <strong>拖放企业文档，或点击选择</strong>
      <small>单次最多 100 个文件 · 大文件自动 Multipart · 文件字节直达 MinIO</small>
    </button>
    <!-- eslint-disable-next-line vue/html-self-closing -->
    <input ref="input" class="hidden-input" type="file" multiple @change="onInput" />

    <ElAlert
      v-if="upload.errorMessage.value"
      :title="upload.errorMessage.value"
      type="error"
      show-icon
      :closable="false"
    />

    <div v-if="upload.entries.value.length" class="queue-list">
      <UploadQueueItem
        v-for="entry in upload.entries.value"
        :key="entry.clientFileId"
        :entry="entry"
        :busy="upload.busy.value"
        @remove="upload.removeEntry"
        @retry="upload.retry"
        @cancel="upload.cancelEntry"
      />
    </div>
    <ElEmpty v-else :image-size="70" description="尚未选择文件" />

    <footer class="upload-footer">
      <div>
        <strong>{{ upload.entries.value.length }}</strong>
        <span>个文件 · {{ upload.readyCount.value }} 个可开始</span>
      </div>
      <div class="footer-actions">
        <ElButton v-if="upload.session.value?.status === 'ACTIVE'" @click="upload.cancelSession">
          取消会话
        </ElButton>
        <ElButton
          type="primary"
          :loading="upload.busy.value"
          :disabled="upload.readyCount.value === 0"
          @click="start"
        >
          创建直传任务
        </ElButton>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.upload-panel {
  min-width: 0;
  background: var(--surface-elevated);
  border: 1px solid var(--line-strong);
}
.panel-heading {
  min-height: 82px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--line-subtle);
}
.panel-heading span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.13em;
}
.panel-heading h2 {
  margin: 4px 0 0;
  font-family: var(--font-editorial);
  font-size: 20px;
}
.space-select {
  width: min(300px, 48%);
}
.drop-zone {
  width: calc(100% - 44px);
  min-height: 150px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 7px;
  margin: 22px;
  padding: 24px;
  color: var(--text-secondary);
  background:
    linear-gradient(rgb(250 248 242 / 88%), rgb(250 248 242 / 88%)),
    repeating-linear-gradient(45deg, var(--accent-050), var(--accent-050) 8px, #fff 8px, #fff 16px);
  border: 1px dashed var(--line-strong);
  cursor: pointer;
  transition: 0.18s ease;
}
.drop-zone:hover,
.drop-zone.is-dragging {
  color: var(--accent-700);
  border-color: var(--accent-500);
  transform: translateY(-1px);
}
.upload-glyph {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  color: #fff;
  background: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 18px;
}
.drop-zone strong {
  font-size: 14px;
}
.drop-zone small {
  color: var(--text-tertiary);
  font-size: 10px;
}
.hidden-input {
  display: none;
}
.queue-list {
  max-height: 360px;
  overflow: auto;
  padding: 0 22px;
  border-top: 1px solid var(--line-subtle);
}
.upload-footer {
  min-height: 70px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 22px;
  background: #f5f2eb;
  border-top: 1px solid var(--line-subtle);
}
.upload-footer strong {
  margin-right: 6px;
  font-family: var(--font-editorial);
  font-size: 24px;
}
.upload-footer span {
  color: var(--text-secondary);
  font-size: 11px;
}
.footer-actions {
  display: flex;
  gap: 8px;
}
@media (max-width: 680px) {
  .panel-heading,
  .upload-footer {
    align-items: stretch;
    flex-direction: column;
  }
  .space-select {
    width: 100%;
  }
  .drop-zone small {
    text-align: center;
  }
}
</style>
