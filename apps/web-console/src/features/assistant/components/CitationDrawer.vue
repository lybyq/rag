<!-- 每次打开都使用本次鉴权结果，关闭即销毁正文。 @requirement WEB-021 -->
<script setup lang="ts">
import type { CitationPreview } from '@rag/contracts';

defineProps<{ open: boolean; loading: boolean; citation?: CitationPreview }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <ElDrawer
    :model-value="open"
    title="证据预览"
    size="480px"
    destroy-on-close
    @close="emit('close')"
  >
    <ElSkeleton v-if="loading" :rows="7" animated />
    <ElEmpty v-else-if="!citation" description="引用不可见、已失效或仍在鉴权" />
    <article v-else class="citation-sheet">
      <span class="citation-kicker">AUTHORIZED SOURCE</span>
      <h3>{{ citation.title }}</h3>
      <p class="heading-path">{{ citation.headingPath.join(' / ') || '文档正文' }}</p>
      <blockquote>{{ citation.excerpt }}</blockquote>
      <dl>
        <div>
          <dt>发布时间</dt>
          <dd>{{ new Date(citation.publishedAt).toLocaleString() }}</dd>
        </div>
        <div>
          <dt>生效时间</dt>
          <dd>{{ new Date(citation.effectiveFrom).toLocaleString() }}</dd>
        </div>
        <div>
          <dt>定位信息</dt>
          <dd>{{ citation.sourceLocations.length }} 项</dd>
        </div>
      </dl>
    </article>
  </ElDrawer>
</template>

<style scoped>
.citation-sheet {
  color: var(--text-primary);
}
.citation-kicker {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
}
.citation-sheet h3 {
  margin: 10px 0 4px;
  font-family: var(--font-editorial);
  font-size: 24px;
}
.heading-path {
  color: var(--text-tertiary);
  font-size: 12px;
}
blockquote {
  margin: 24px 0;
  padding: 18px;
  border-left: 3px solid var(--accent-500);
  background: var(--surface-canvas);
  line-height: 1.8;
}
dl {
  display: grid;
  gap: 12px;
}
dl div {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--line-subtle);
}
dt {
  color: var(--text-tertiary);
}
dd {
  margin: 0;
  text-align: right;
}
</style>
