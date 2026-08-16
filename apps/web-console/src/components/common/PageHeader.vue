<script setup lang="ts">
defineProps<{
  eyebrow: string;
  title: string;
  description: string;
}>();
</script>

<template>
  <header class="page-header">
    <div>
      <span class="eyebrow">{{ eyebrow }}</span>
      <h1>{{ title }}</h1>
      <p>{{ description }}</p>
    </div>
    <slot name="actions" />
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 32px;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--line-strong);
}
.eyebrow {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
}
h1 {
  margin: 12px 0 8px;
  font-family: var(--font-editorial);
  font-size: clamp(28px, 4vw, 44px);
  line-height: 1.05;
  font-weight: 700;
  letter-spacing: -0.035em;
}
p {
  max-width: 680px;
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.75;
}
@media (max-width: 700px) {
  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
