<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import { useRoute } from 'vue-router';

const route = useRoute();
</script>

<template>
  <div class="placeholder-view">
    <PageHeader
      :eyebrow="`${String(route.meta.module)} · PLANNED MODULE`"
      :title="String(route.meta.title)"
      description="该能力已进入全量需求清单，将严格按模块依赖顺序实现、讲解和验收。M00 先保证它未来接入时拥有稳定边界。"
    />
    <div class="placeholder-mark" aria-hidden="true">
      {{ String(route.meta.module) }}
    </div>
  </div>
</template>

<style scoped>
.placeholder-view {
  position: relative;
  max-width: 1200px;
  min-height: 620px;
  margin: 0 auto;
  overflow: hidden;
}
.placeholder-mark {
  position: absolute;
  right: -20px;
  bottom: -50px;
  color: rgb(22 31 38 / 4%);
  font-family: var(--font-editorial);
  font-size: clamp(100px, 20vw, 260px);
  font-weight: 800;
  white-space: nowrap;
}
</style>
