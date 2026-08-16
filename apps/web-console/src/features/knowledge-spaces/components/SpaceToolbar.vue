<script setup lang="ts">
import type { KnowledgeSpaceStatus } from '@rag/contracts';

defineProps<{
  search: string;
  status: '' | KnowledgeSpaceStatus;
  loading: boolean;
  canCreate: boolean;
}>();

const emit = defineEmits<{
  'update:search': [value: string];
  'update:status': [value: '' | KnowledgeSpaceStatus];
  search: [];
  create: [];
}>();
</script>

<template>
  <div class="space-toolbar">
    <div class="filters">
      <ElInput
        :model-value="search"
        clearable
        class="search-input"
        placeholder="搜索空间名称或编码"
        aria-label="搜索知识空间"
        @update:model-value="emit('update:search', String($event))"
        @keyup.enter="emit('search')"
        @clear="emit('search')"
      />
      <ElSelect
        :model-value="status"
        class="status-select"
        aria-label="按状态筛选"
        @update:model-value="emit('update:status', $event as '' | KnowledgeSpaceStatus)"
        @change="emit('search')"
      >
        <ElOption label="全部状态" value="" />
        <ElOption label="运行中" value="ACTIVE" />
        <ElOption label="已停用" value="INACTIVE" />
      </ElSelect>
      <ElButton :loading="loading" @click="emit('search')">查询</ElButton>
    </div>
    <ElButton v-if="canCreate" type="primary" @click="emit('create')">新建知识空间</ElButton>
  </div>
</template>

<style scoped>
.space-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 20px;
  background: var(--surface-elevated);
  border-bottom: 1px solid var(--line-subtle);
}
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
}
.search-input {
  width: min(340px, 42vw);
}
.status-select {
  width: 132px;
}
/*
 * 工作台左侧宽度会受导航栏和权限抽屉影响，因此这里使用容器查询，
 * 不能只根据整个浏览器窗口宽度判断。这样即使大屏打开权限抽屉，工具栏也不会被挤坏。
 */
@container (max-width: 760px) {
  .space-toolbar,
  .filters {
    align-items: stretch;
    flex-direction: column;
  }
  .search-input,
  .status-select {
    width: 100%;
  }
}
</style>
