<!-- Route View 只组合总览 Feature。 -->
<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import PlatformOverviewPanel from '@/features/operations/components/PlatformOverviewPanel.vue';
</script>
<template>
  <div class="page">
    <PageHeader
      eyebrow="ENTERPRISE KNOWLEDGE CONTROL"
      title="知识运营总览"
      description="从空间、文档、任务、审核、发布到问答质量，所有数字都来自平台事实源。"
    /><PlatformOverviewPanel />
  </div>
</template>
<style scoped>
.page {
  max-width: 1380px;
  margin: 0 auto;
  display: grid;
  gap: 22px;
}
</style>
