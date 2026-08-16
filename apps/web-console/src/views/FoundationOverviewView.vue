<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import ArchitectureNotes from '@/features/operations/components/ArchitectureNotes.vue';
import DeliveryRoadmap from '@/features/operations/components/DeliveryRoadmap.vue';
import SystemPulse from '@/features/operations/components/SystemPulse.vue';
</script>

<template>
  <div class="foundation-view">
    <PageHeader
      eyebrow="M00 · ENGINEERING FOUNDATION"
      title="让每一次检索，都有工程依据"
      description="当前阶段建立四进程边界、运行时契约、可观测性与可重复开发环境。这里不是功能演示页，而是后续十个模块共同站立的地基。"
    >
      <template #actions>
        <ElTag effect="plain" type="warning"> M00 建设中 </ElTag>
      </template>
    </PageHeader>

    <div class="overview-grid">
      <SystemPulse />
      <DeliveryRoadmap />
      <ArchitectureNotes />
    </div>
  </div>
</template>

<style scoped>
.foundation-view {
  max-width: 1380px;
  margin: 0 auto;
}
.overview-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 18px;
  margin-top: 24px;
}
</style>
