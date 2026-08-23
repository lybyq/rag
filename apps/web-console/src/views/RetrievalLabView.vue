<!-- Route View 只组合检索 Feature。 -->
<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import RetrievalLab from '@/features/assistant/components/RetrievalLab.vue';
</script>
<template>
  <div class="page">
    <PageHeader
      eyebrow="AUTHORIZED RETRIEVAL LAB"
      title="检索测试台"
      description="对一个真实 Run 重放 Query Plan 和混合检索，观察 Dense、Sparse、RRF、Rerank 摘要与剔除原因。"
    /><RetrievalLab />
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
