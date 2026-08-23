<!-- 审计白名单筛选、稳定游标和脱敏 CSV 导出。 @requirement WEB-026 WEB-027 -->
<script setup lang="ts">
/* eslint-disable vue/multiline-html-element-content-newline -- 表格模板遵循 Prettier。 */
import { useAuditConsole } from '../composables/useOperationsConsole';
const state = useAuditConsole();
</script>

<template>
  <section class="audit-console">
    <ElAlert
      v-if="state.errorMessage.value"
      :title="state.errorMessage.value"
      type="error"
      :closable="false"
    >
      <template #default>
        <ElButton text @click="state.load(false)">重试</ElButton>
      </template>
    </ElAlert>
    <ElForm class="audit-filter" inline @submit.prevent="state.load(false)">
      <ElFormItem label="用户"><ElInput v-model="state.filters.userId" clearable /></ElFormItem>
      <ElFormItem label="角色"><ElInput v-model="state.filters.role" clearable /></ElFormItem>
      <ElFormItem label="动作"><ElInput v-model="state.filters.action" clearable /></ElFormItem>
      <ElFormItem label="资源">
        <ElInput v-model="state.filters.resourceType" clearable />
      </ElFormItem>
      <ElFormItem label="结果">
        <ElSelect v-model="state.filters.result" clearable>
          <ElOption label="成功" value="SUCCESS" /><ElOption label="拒绝" value="DENIED" /><ElOption
            label="失败"
            value="FAILURE"
          />
        </ElSelect>
      </ElFormItem>
      <ElFormItem>
        <ElButton type="primary" native-type="submit">查询</ElButton
        ><ElButton @click="state.exportCsv">导出脱敏 CSV</ElButton>
      </ElFormItem>
    </ElForm>
    <ElTable
      v-loading="state.loading.value"
      :data="[...state.items.value]"
      empty-text="没有符合条件的审计记录"
    >
      <ElTableColumn prop="occurredAt" label="时间" min-width="180">
        <template #default="{ row }">
          {{ new Date(row.occurredAt).toLocaleString() }}
        </template>
      </ElTableColumn>
      <ElTableColumn prop="userId" label="用户" min-width="140" /><ElTableColumn
        label="角色"
        min-width="180"
      >
        <template #default="{ row }">{{ row.roles.join(', ') }}</template> </ElTableColumn
      ><ElTableColumn prop="action" label="动作" min-width="170" /><ElTableColumn
        prop="resourceType"
        label="资源"
        min-width="130"
      /><ElTableColumn prop="resourceId" label="资源 ID" min-width="220" /><ElTableColumn
        prop="result"
        label="结果"
        width="100"
      >
        <template #default="{ row }">
          <ElTag
            :type="
              row.result === 'SUCCESS' ? 'success' : row.result === 'DENIED' ? 'warning' : 'danger'
            "
            effect="plain"
          >
            {{ row.result }}
          </ElTag>
        </template> </ElTableColumn
      ><ElTableColumn prop="reason" label="原因" min-width="180" />
    </ElTable>
    <div class="audit-pagination">
      <ElButton
        v-if="state.nextCursor.value"
        :loading="state.loading.value"
        @click="state.load(true)"
      >
        加载更多 </ElButton
      ><span v-else>已到达当前结果末尾</span>
    </div>
  </section>
</template>

<style scoped>
.audit-console {
  padding: 22px;
  border: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
}
.audit-filter {
  margin-bottom: 10px;
  padding: 15px;
  background: #efebe2;
}
.audit-filter :deep(.el-input),
.audit-filter :deep(.el-select) {
  width: 150px;
}
.audit-pagination {
  display: flex;
  justify-content: center;
  padding: 18px 0 0;
  color: var(--text-tertiary);
  font-size: 11px;
}
</style>
