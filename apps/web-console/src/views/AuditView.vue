<!-- Route View 只组合审计 Feature。 -->
<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import AuditConsole from '@/features/operations/components/AuditConsole.vue';
</script>
<template>
  <div class="page">
    <PageHeader
      eyebrow="COMPLIANCE AUDIT"
      title="审计检索与导出"
      description="按用户、角色、动作、资源、结果和时间检索；导出结果已脱敏并防止 CSV 公式注入。"
    /><AuditConsole />
  </div>
</template>
<style scoped>
.page {
  max-width: 1500px;
  margin: 0 auto;
  display: grid;
  gap: 22px;
}
</style>
