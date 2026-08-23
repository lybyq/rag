<!-- Route View 只组合审核 Feature。 -->
<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import QualityReviewWorkbench from '@/features/document-ingestion/components/QualityReviewWorkbench.vue';
</script>
<template>
  <div class="page">
    <PageHeader
      eyebrow="HUMAN QUALITY GATE"
      title="知识审核台"
      description="并排核对原文定位、解析 Block、OCR 置信度、质量问题和 Chunk，再执行批准、拒绝或要求重处理。"
    /><QualityReviewWorkbench />
  </div>
</template>
<style scoped>
.page {
  max-width: 1600px;
  margin: 0 auto;
  display: grid;
  gap: 22px;
}
</style>
