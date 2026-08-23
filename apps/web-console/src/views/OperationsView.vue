<!-- Route View 只组合运维 Feature。 -->
<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import OperationsDashboardPanel from '@/features/operations/components/OperationsDashboardPanel.vue';
</script>
<template>
  <div class="page">
    <PageHeader
      eyebrow="OPERATIONS & RELIABILITY"
      title="运行健康与告警"
      description="统一查看 API、Worker、基础设施、模型、队列、卡住任务和 DLQ，并执行受审计的运维动作。"
    /><OperationsDashboardPanel />
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
