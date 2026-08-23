<!-- 原文 Block 与 Chunk/质量双栏审核台；审核动作仍经乐观锁和服务端鉴权。 @requirement WEB-016 -->
<script setup lang="ts">
import { shallowRef } from 'vue';
import KnowledgeQualityPanel from './KnowledgeQualityPanel.vue';
import ParseInspectionPanel from './ParseInspectionPanel.vue';
const input = shallowRef('');
const versionId = shallowRef('');
function inspect(): void {
  versionId.value = input.value.trim();
}
</script>
<template>
  <section class="review-workbench">
    <form class="review-search" @submit.prevent="inspect">
      <ElInput
        v-model="input"
        placeholder="输入待审核 Document Version UUID"
        aria-label="文档版本 UUID"
      /><ElButton native-type="submit" type="primary">打开审核证据</ElButton>
    </form>
    <ElEmpty
      v-if="!versionId"
      description="选择待审核版本后，对照查看页码、OCR 置信度、解析问题和 Chunk"
    />
    <div v-else class="review-columns">
      <div>
        <header><span>SOURCE & PARSE</span><strong>原文定位与解析 Block</strong></header>
        <ParseInspectionPanel :document-version-id="versionId" />
      </div>
      <div>
        <header><span>QUALITY & CHUNK</span><strong>质量问题与知识切块</strong></header>
        <KnowledgeQualityPanel :document-version-id="versionId" />
      </div>
    </div>
  </section>
</template>
<style scoped>
.review-workbench {
  border: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
}
.review-search {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 9px;
  padding: 18px;
  border-bottom: 1px solid var(--line-subtle);
}
.review-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.review-columns > div {
  min-width: 0;
  border-right: 1px solid var(--line-strong);
}
.review-columns > div:last-child {
  border-right: 0;
}
.review-columns header {
  display: grid;
  gap: 4px;
  padding: 15px 20px;
  background: var(--ink-950);
  color: #fff;
}
.review-columns header span {
  color: var(--accent-400);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.13em;
}
.review-columns header strong {
  font-family: var(--font-editorial);
}
@media (max-width: 1050px) {
  .review-columns {
    grid-template-columns: 1fr;
  }
  .review-columns > div {
    border-right: 0;
    border-bottom: 1px solid var(--line-strong);
  }
}
</style>
