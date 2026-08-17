<script setup lang="ts">
/** 安全与解析问题列表；只展示平台脱敏后的公开消息。 */
import type { ParseIssue } from '@rag/contracts';

defineProps<{ issues: readonly ParseIssue[] }>();
</script>

<template>
  <section class="finding-list">
    <header>
      <h5>检查记录</h5>
      <span>{{ issues.length }} ISSUES</span>
    </header>
    <div v-if="issues.length" class="finding-scroll">
      <article v-for="issue in issues" :key="issue.id" :class="issue.severity.toLowerCase()">
        <div>
          <strong>{{ issue.code }}</strong>
          <span v-if="issue.pageNo">PAGE {{ issue.pageNo }}</span>
        </div>
        <p>{{ issue.message }}</p>
      </article>
    </div>
    <p v-else class="clean-copy">没有需要人工关注的安全或 OCR 警告。</p>
  </section>
</template>

<style scoped>
.finding-list {
  margin-top: 12px;
  border-top: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line-strong);
}
header,
article > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
header {
  padding: 9px 0;
}
h5 {
  margin: 0;
  font-family: var(--font-editorial);
}
header span,
article span,
article strong {
  font-family: var(--font-mono);
  font-size: 8px;
}
header span,
article span {
  color: var(--text-tertiary);
}
.finding-scroll {
  max-height: 140px;
  overflow: auto;
}
article {
  padding: 9px 10px;
  border-top: 1px solid var(--line-subtle);
  background: #fffdf8;
}
article.error {
  box-shadow: inset 3px 0 #a7463c;
}
article.warning {
  box-shadow: inset 3px 0 #bd7b1e;
}
article p,
.clean-copy {
  margin: 5px 0 0;
  color: var(--text-secondary);
  font-size: 9px;
}
.clean-copy {
  margin: 0;
  padding: 12px 0;
  border-top: 1px solid var(--line-subtle);
}
</style>
