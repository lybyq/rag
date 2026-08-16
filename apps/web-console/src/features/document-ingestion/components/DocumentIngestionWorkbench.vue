<script setup lang="ts">
/** M02 页面级业务组合：共享空间筛选，并在新任务创建后刷新任务区。 */
import { platformApiFetch } from '@/features/identity/services/platformApi';
import { KnowledgeSpaceListEnvelopeSchema, type KnowledgeSpace } from '@rag/contracts';
import { onMounted, shallowRef } from 'vue';
import JobCenter from './JobCenter.vue';
import UploadWorkbench from './UploadWorkbench.vue';

const spaces = shallowRef<readonly KnowledgeSpace[]>([]);
const selectedSpaceId = shallowRef('');

async function loadSpaces(): Promise<void> {
  const response = await platformApiFetch(
    '/api/v1/spaces?status=ACTIVE',
    KnowledgeSpaceListEnvelopeSchema,
  );
  spaces.value = response.data.items;
  selectedSpaceId.value ||=
    spaces.value.find((space) => space.effectivePermissions.includes('WRITE'))?.id ?? '';
}

onMounted(() => void loadSpaces());
</script>

<template>
  <div class="ingestion-workbench">
    <div class="ingestion-context">
      <div><span>01</span><strong>浏览器直传</strong><small>字节不经过 API</small></div>
      <div><span>02</span><strong>HEAD 核验</strong><small>大小、MIME、可用 Hash</small></div>
      <div><span>03</span><strong>事务入队</strong><small>PG 事实 + Outbox</small></div>
      <div><span>04</span><strong>可恢复进度</strong><small>SSE / ETag 游标</small></div>
    </div>
    <UploadWorkbench v-model:space-id="selectedSpaceId" :spaces="spaces" />
    <JobCenter :spaces="spaces" />
  </div>
</template>

<style scoped>
.ingestion-workbench {
  margin-top: 24px;
}
.ingestion-context {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin-bottom: 14px;
  border: 1px solid var(--line-strong);
}
.ingestion-context > div {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 2px 9px;
  padding: 13px 15px;
  background: rgb(250 248 242 / 72%);
  border-right: 1px solid var(--line-subtle);
}
.ingestion-context > div:last-child {
  border-right: 0;
}
.ingestion-context span {
  grid-row: 1 / 3;
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 10px;
}
.ingestion-context strong {
  font-size: 11px;
}
.ingestion-context small {
  color: var(--text-tertiary);
  font-size: 9px;
}
@media (max-width: 850px) {
  .ingestion-context {
    grid-template-columns: repeat(2, 1fr);
  }
  .ingestion-context > div:nth-child(2) {
    border-right: 0;
  }
  .ingestion-context > div:nth-child(-n + 2) {
    border-bottom: 1px solid var(--line-subtle);
  }
}
</style>
