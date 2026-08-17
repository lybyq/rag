<script setup lang="ts">
/** M04 Chunk 浏览表；只展示转义后的正文和服务端定位事实，不执行 Markdown/HTML。 */
import type { KnowledgeChunk } from '@rag/contracts';
import { computed } from 'vue';

const props = defineProps<{
  chunks: readonly KnowledgeChunk[];
  loadingMore: boolean;
  hasMore: boolean;
}>();
const emit = defineEmits<{ loadMore: [] }>();
const rows = computed(() => [...props.chunks]);

function location(chunk: KnowledgeChunk): string {
  const first = chunk.sourceLocations[0];
  const last = chunk.sourceLocations.at(-1);
  if (!first) return '—';
  if (first.pageNo)
    return first.pageNo === last?.pageNo ? `P${first.pageNo}` : `P${first.pageNo}–${last?.pageNo}`;
  if (first.slideNo) return `SLIDE ${first.slideNo}`;
  return first.sheetName ?? '—';
}
</script>

<template>
  <section class="chunk-table">
    <header class="chunk-heading">
      <div>
        <span>REVERSIBLE CHUNKS</span>
        <h5>Parent / Child 检查</h5>
      </div>
      <strong>{{ chunks.length }}</strong>
    </header>
    <ElTable v-if="chunks.length" :data="rows" size="small" max-height="320">
      <ElTableColumn prop="ordinal" label="#" width="48" />
      <ElTableColumn label="粒度" width="88">
        <template #default="scope">
          <ElTag
            :type="(scope.row as KnowledgeChunk).granularity === 'CHILD' ? 'primary' : 'info'"
            size="small"
            effect="plain"
          >
            {{ (scope.row as KnowledgeChunk).granularity }}
          </ElTag>
        </template>
      </ElTableColumn>
      <ElTableColumn prop="contentType" label="类型" width="86" />
      <ElTableColumn label="定位" width="92">
        <template #default="scope">{{ location(scope.row as KnowledgeChunk) }}</template>
      </ElTableColumn>
      <ElTableColumn prop="tokenCount" label="Tokens" width="76" />
      <ElTableColumn label="展示正文" min-width="220" show-overflow-tooltip>
        <template #default="scope">{{ (scope.row as KnowledgeChunk).displayContent }}</template>
      </ElTableColumn>
      <ElTableColumn label="索引" width="92">
        <template #default="scope">
          <span :class="(scope.row as KnowledgeChunk).eligibleForIndex ? 'eligible' : 'blocked'">
            {{ (scope.row as KnowledgeChunk).eligibleForIndex ? '允许' : '阻断' }}
          </span>
        </template>
      </ElTableColumn>
    </ElTable>
    <ElEmpty v-else :image-size="44" description="当前运行尚未生成 Chunk" />
    <footer v-if="hasMore" class="chunk-footer">
      <ElButton :loading="loadingMore" text type="primary" @click="emit('loadMore')">
        加载更多 Chunk
      </ElButton>
    </footer>
  </section>
</template>

<style scoped>
.chunk-table {
  margin-top: 14px;
}
.chunk-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 8px;
}
.chunk-heading span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 8px;
  letter-spacing: 0.12em;
}
.chunk-heading h5 {
  margin: 2px 0 0;
  font-family: var(--font-editorial);
}
.chunk-heading strong {
  font-family: var(--font-editorial);
  font-size: 21px;
}
.eligible {
  color: #315d48;
  font-weight: 700;
}
.blocked {
  color: #a7463c;
  font-weight: 700;
}
.chunk-footer {
  display: flex;
  justify-content: center;
  border-bottom: 1px solid var(--line-subtle);
}
</style>
