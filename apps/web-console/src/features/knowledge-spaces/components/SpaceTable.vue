<script setup lang="ts">
import type { KnowledgeSpace, SpacePermission } from '@rag/contracts';
import { getSpaceActionVisibility } from './spaceActions';

defineProps<{
  items: readonly KnowledgeSpace[];
  loading: boolean;
}>();

const emit = defineEmits<{
  manage: [space: KnowledgeSpace];
  edit: [space: KnowledgeSpace];
  deactivate: [space: KnowledgeSpace];
}>();

const permissionLabels: Readonly<Record<SpacePermission, string>> = {
  READ: '读取',
  WRITE: '维护',
  REVIEW: '审核',
  ADMIN: '管理',
};

/** 用稳定中文格式展示服务端 ISO 时间。 */
function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
</script>

<template>
  <ElTable
    v-loading="loading"
    :data="[...items]"
    class="space-table"
    empty-text="暂无可访问的知识空间"
  >
    <ElTableColumn label="空间" min-width="250">
      <template #default="{ row }: { row: KnowledgeSpace }">
        <button class="space-identity" type="button" @click="emit('manage', row)">
          <strong>{{ row.name }}</strong>
          <span>{{ row.code }}</span>
        </button>
      </template>
    </ElTableColumn>
    <ElTableColumn label="状态" width="94">
      <template #default="{ row }: { row: KnowledgeSpace }">
        <span class="status" :class="row.status.toLowerCase()">
          {{ row.status === 'ACTIVE' ? '运行中' : '已停用' }}
        </span>
      </template>
    </ElTableColumn>
    <ElTableColumn prop="ownerUserId" label="负责人" min-width="145" />
    <ElTableColumn prop="documentCount" label="文档" width="76" align="right" />
    <ElTableColumn label="我的权限" min-width="185">
      <template #default="{ row }: { row: KnowledgeSpace }">
        <span
          v-for="permission in row.effectivePermissions"
          :key="permission"
          class="permission-chip"
        >
          {{ permissionLabels[permission] }}
        </span>
      </template>
    </ElTableColumn>
    <ElTableColumn label="策略" width="78" align="right">
      <template #default="{ row }: { row: KnowledgeSpace }">
        <span class="version">v{{ row.policyVersion }}</span>
      </template>
    </ElTableColumn>
    <ElTableColumn label="更新时间" min-width="168">
      <template #default="{ row }: { row: KnowledgeSpace }">
        <span>{{ formatTime(row.updatedAt) }}</span>
      </template>
    </ElTableColumn>
    <ElTableColumn label="操作" width="202" fixed="right">
      <template #default="{ row }: { row: KnowledgeSpace }">
        <ElButton v-if="getSpaceActionVisibility(row).manage" link @click="emit('manage', row)">
          授权
        </ElButton>
        <ElButton v-if="getSpaceActionVisibility(row).edit" link @click="emit('edit', row)">
          编辑
        </ElButton>
        <ElButton
          v-if="getSpaceActionVisibility(row).deactivate"
          link
          type="danger"
          @click="emit('deactivate', row)"
        >
          停用
        </ElButton>
      </template>
    </ElTableColumn>
  </ElTable>
</template>

<style scoped>
.space-table {
  --el-table-header-bg-color: #ebe7df;
  --el-table-row-hover-bg-color: #fff5eb;
  --el-table-border-color: var(--line-subtle);
  width: 100%;
}
.space-identity {
  padding: 0;
  text-align: left;
  color: inherit;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.space-identity strong,
.space-identity span {
  display: block;
}
.space-identity strong {
  margin-bottom: 3px;
  font-weight: 650;
}
.space-identity span,
.version {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 10px;
}
.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.status::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-tertiary);
  content: '';
}
.status.active::before {
  background: var(--success-500);
}
.permission-chip {
  display: inline-block;
  margin: 2px 4px 2px 0;
  padding: 2px 6px;
  color: var(--accent-700);
  font-size: 10px;
  background: var(--accent-050);
  border: 1px solid var(--accent-200);
}
</style>
