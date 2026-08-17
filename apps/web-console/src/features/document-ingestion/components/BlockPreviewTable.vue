<script setup lang="ts">
/** DocumentBlock 预览表；正文只显示截断预览，定位字段保持完整。 */
import type { DocumentBlock } from '@rag/contracts';
import { computed } from 'vue';

const props = defineProps<{
  blocks: readonly DocumentBlock[];
  loadingMore: boolean;
  hasMore: boolean;
}>();
const emit = defineEmits<{ loadMore: []; retry: [] }>();
const rows = computed(() => [...props.blocks]);

function location(block: DocumentBlock): string {
  if (block.pageNo) return `P${block.pageNo}`;
  if (block.slideNo) return `SLIDE ${block.slideNo}`;
  if (block.sheetName) return block.sheetName;
  return '—';
}

function bbox(block: DocumentBlock): string {
  if (!block.bbox) return '—';
  return [block.bbox.x1, block.bbox.y1, block.bbox.x2, block.bbox.y2]
    .map((value) => value.toFixed(2))
    .join(' / ');
}
</script>

<template>
  <section class="block-preview">
    <header>
      <div>
        <span>UNIFIED BLOCKS</span>
        <h5>结构预览</h5>
      </div>
      <strong>{{ blocks.length }}</strong>
    </header>
    <ElTable v-if="blocks.length" :data="rows" size="small" max-height="260">
      <ElTableColumn prop="ordinal" label="#" width="48" />
      <ElTableColumn label="定位" width="88">
        <template #default="scope">{{ location(scope.row as DocumentBlock) }}</template>
      </ElTableColumn>
      <ElTableColumn prop="type" label="类型" width="92" />
      <ElTableColumn label="正文" min-width="190" show-overflow-tooltip>
        <template #default="scope">{{ (scope.row as DocumentBlock).text || '（空块）' }}</template>
      </ElTableColumn>
      <ElTableColumn label="BBox" min-width="128">
        <template #default="scope">{{ bbox(scope.row as DocumentBlock) }}</template>
      </ElTableColumn>
    </ElTable>
    <ElEmpty v-else :image-size="44" description="当前运行尚未生成 Block" />
    <footer v-if="hasMore">
      <ElButton :loading="loadingMore" text type="primary" @click="emit('loadMore')">
        加载更多 Block
      </ElButton>
    </footer>
  </section>
</template>

<style scoped>
.block-preview {
  margin-top: 14px;
}
header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 8px;
}
header span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 8px;
  letter-spacing: 0.12em;
}
h5 {
  margin: 2px 0 0;
  font-family: var(--font-editorial);
}
header strong {
  font-family: var(--font-editorial);
  font-size: 21px;
}
footer {
  display: flex;
  justify-content: center;
  border-bottom: 1px solid var(--line-subtle);
}
</style>
