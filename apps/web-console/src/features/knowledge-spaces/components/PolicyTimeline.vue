<script setup lang="ts">
import type { KnowledgeSpacePolicyVersion } from '@rag/contracts';

defineProps<{ items: readonly KnowledgeSpacePolicyVersion[] }>();

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
</script>

<template>
  <ol class="timeline">
    <li v-for="version in items" :key="version.version">
      <span class="version">v{{ version.version }}</span>
      <div>
        <strong>{{ version.changeReason }}</strong>
        <small>{{ version.changedBy }} · {{ formatTime(version.createdAt) }}</small>
        <small>{{ version.grants.length }} 条授权</small>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.timeline {
  display: grid;
  gap: 14px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}
.timeline li {
  display: grid;
  grid-template-columns: 38px 1fr;
  gap: 10px;
}
.version {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 10px;
}
.timeline strong,
.timeline small {
  display: block;
}
.timeline strong {
  font-size: 11px;
  font-weight: 600;
}
.timeline small {
  margin-top: 4px;
  color: var(--text-tertiary);
  font-size: 9px;
  line-height: 1.5;
}
</style>
