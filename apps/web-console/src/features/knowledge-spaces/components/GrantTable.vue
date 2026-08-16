<script setup lang="ts">
import type { SpaceGrant } from '@rag/contracts';

defineProps<{ items: readonly SpaceGrant[]; submitting: boolean }>();
const emit = defineEmits<{ revoke: [grant: SpaceGrant] }>();
</script>

<template>
  <div class="grant-table">
    <div v-for="grant in items" :key="grant.id" class="grant-row">
      <span class="subject-type">{{ grant.subjectType }}</span>
      <div class="subject">
        <strong>{{ grant.subjectId }}</strong>
        <small>{{ grant.permissions.join(' · ') }}</small>
      </div>
      <ElButton link type="danger" :disabled="submitting" @click="emit('revoke', grant)">
        撤权
      </ElButton>
    </div>
    <ElEmpty v-if="items.length === 0" description="暂无授权" :image-size="54" />
  </div>
</template>

<style scoped>
.grant-table {
  margin-top: 14px;
  border-top: 1px solid var(--line-subtle);
}
.grant-row {
  display: grid;
  grid-template-columns: 46px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line-subtle);
}
.subject-type {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
.subject strong,
.subject small {
  display: block;
}
.subject strong {
  font-size: 12px;
}
.subject small {
  margin-top: 4px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
</style>
