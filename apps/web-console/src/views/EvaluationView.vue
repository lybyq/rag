<!-- Route View 只组合评测 Feature。 -->
<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import EvaluationCenter from '@/features/operations/components/EvaluationCenter.vue';
</script>
<template>
  <div class="page">
    <PageHeader
      eyebrow="EVALUATION & BASELINE"
      title="质量评测中心"
      description="用版本化 Golden Set 驱动真实 RAG Run，保存模型、Prompt、Flow、Policy、Manifest 和代码快照，并下钻回归失败样本。"
    /><EvaluationCenter />
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
