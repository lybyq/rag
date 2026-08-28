<!-- 文档筛选、游标分页、批量动作和详情多标签页。 @requirement WEB-009 WEB-015 WEB-027 -->
<script setup lang="ts">
/* eslint-disable vue/multiline-html-element-content-newline -- 描述字段由 Prettier 保持紧凑。 */
import type { Document } from '@rag/contracts';
import { ElMessageBox } from 'element-plus/es';
import { computed } from 'vue';
import { useDocumentLibrary } from '../composables/useDocumentLibrary';
import KnowledgeQualityPanel from './KnowledgeQualityPanel.vue';
import ParseInspectionPanel from './ParseInspectionPanel.vue';
const props = defineProps<{ spaces: readonly { id: string; name: string }[] }>();
const library = useDocumentLibrary();
const detailOpen = computed({
  get: () => Boolean(library.detail.value),
  set: (value) => {
    if (!value) library.detail.value = undefined;
  },
});
const contentTypes = [
  ['PDF', 'application/pdf'],
  ['Word', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['Excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['文本', 'text/plain'],
  ['Markdown', 'text/markdown'],
] as const;
function selection(value: Document[]): void {
  library.selected.value = value;
}
async function batch(): Promise<void> {
  const answer = await ElMessageBox.prompt(
    '每个文档都会创建新修订，原版本保持不变。',
    '批量重处理',
    {
      inputPattern: /^.{2,300}$/,
      inputErrorMessage: '原因需为 2～300 个字符',
      type: 'warning',
    },
  ).catch(() => undefined);
  const reason =
    answer && typeof answer === 'object' && 'value' in answer ? String(answer.value) : '';
  if (reason) await library.batchReprocess(reason);
}
</script>

<template>
  <section class="document-library">
    <header>
      <div>
        <span>DOCUMENT CATALOG</span>
        <h2>文档库</h2>
      </div>
      <ElButton :disabled="library.selected.value.length === 0" @click="batch">批量重处理</ElButton>
    </header>
    <ElAlert
      v-if="library.errorMessage.value"
      :title="library.errorMessage.value"
      type="error"
      :closable="false"
    >
      <template #default>
        <ElButton text @click="library.load(false)">重试</ElButton>
      </template>
    </ElAlert>
    <ElAlert
      v-if="library.batchMessage.value"
      :title="library.batchMessage.value"
      type="success"
      show-icon
    />
    <ElForm class="document-filters" inline @submit.prevent="library.load(false)">
      <ElFormItem label="搜索">
        <ElInput v-model="library.filters.search" clearable placeholder="标题关键词" />
      </ElFormItem>
      <ElFormItem label="空间">
        <ElSelect v-model="library.filters.spaceId" clearable>
          <ElOption
            v-for="space in props.spaces"
            :key="space.id"
            :label="space.name"
            :value="space.id"
          />
        </ElSelect>
      </ElFormItem>
      <ElFormItem label="状态">
        <ElSelect v-model="library.filters.status" clearable>
          <ElOption label="有效" value="ACTIVE" /><ElOption label="归档" value="ARCHIVED" />
        </ElSelect>
      </ElFormItem>
      <ElFormItem label="格式">
        <ElSelect v-model="library.filters.contentType" clearable>
          <ElOption v-for="item in contentTypes" :key="item[1]" :label="item[0]" :value="item[1]" />
        </ElSelect>
      </ElFormItem>
      <ElFormItem label="最新版本">
        <ElInputNumber
          v-model="library.filters.latestVersionNumber"
          :min="1"
          :precision="0"
          controls-position="right"
          placeholder="全部"
        />
      </ElFormItem>
      <ElFormItem label="排序">
        <ElSelect v-model="library.filters.sort">
          <ElOption label="最近更新" value="UPDATED_DESC" /><ElOption
            label="最早更新"
            value="UPDATED_ASC"
          />
        </ElSelect>
      </ElFormItem>
      <ElFormItem><ElButton native-type="submit" type="primary">筛选</ElButton></ElFormItem>
    </ElForm>
    <ElTable
      v-loading="library.loading.value"
      :data="[...library.items.value]"
      row-key="id"
      empty-text="没有符合条件的文档"
      @selection-change="selection"
      @row-click="(row) => library.inspect(row.id)"
    >
      <ElTableColumn type="selection" width="46" /><ElTableColumn
        prop="title"
        label="标题"
        min-width="220"
      /><ElTableColumn prop="latestFileName" label="最新文件" min-width="190" /><ElTableColumn
        prop="latestContentType"
        label="格式"
        min-width="170"
      /><ElTableColumn prop="status" label="状态" width="100" /><ElTableColumn
        prop="latestVersionNumber"
        label="版本"
        width="80"
      /><ElTableColumn prop="createdBy" label="创建人" min-width="130" /><ElTableColumn
        label="更新时间"
        min-width="170"
      >
        <template #default="{ row }">
          {{ new Date(row.updatedAt).toLocaleString() }}
        </template>
      </ElTableColumn>
    </ElTable>
    <div class="load-more">
      <ElButton v-if="library.nextCursor.value" @click="library.load(true)">加载更多</ElButton
      ><span v-else>已到达当前结果末尾</span>
    </div>
    <ElDrawer v-model="detailOpen" title="文档详情" size="72%" destroy-on-close>
      <ElTabs v-if="library.detail.value">
        <ElTabPane label="概览">
          <ElDescriptions :column="2" border>
            <ElDescriptionsItem label="标题">
              {{ library.detail.value.document.title }} </ElDescriptionsItem
            ><ElDescriptionsItem label="状态">
              {{ library.detail.value.document.status }} </ElDescriptionsItem
            ><ElDescriptionsItem label="文档 ID">
              {{ library.detail.value.document.id }} </ElDescriptionsItem
            ><ElDescriptionsItem label="空间 ID">
              {{ library.detail.value.document.spaceId }}
            </ElDescriptionsItem>
          </ElDescriptions>
        </ElTabPane>
        <ElTabPane label="版本历史">
          <ElTable :data="[...library.detail.value.versions]">
            <ElTableColumn prop="versionNumber" label="版本" /><ElTableColumn
              prop="contentRevision"
              label="内容修订"
            /><ElTableColumn prop="status" label="状态" /><ElTableColumn
              prop="createdAt"
              label="创建时间"
            />
          </ElTable>
        </ElTabPane>
        <ElTabPane label="原文 / Block">
          <ParseInspectionPanel
            v-if="library.detail.value.versions[0]"
            :document-version-id="library.detail.value.versions[0].id"
          /><ElEmpty v-else description="没有版本" />
        </ElTabPane>
        <ElTabPane label="质量 / Chunk">
          <KnowledgeQualityPanel
            v-if="library.detail.value.versions[0]"
            :document-version-id="library.detail.value.versions[0].id"
          /><ElEmpty v-else description="没有版本" />
        </ElTabPane>
        <ElTabPane label="处理历史 / 审计">
          <p>创建人：{{ library.detail.value.document.createdBy }}</p>
          <p>创建：{{ new Date(library.detail.value.document.createdAt).toLocaleString() }}</p>
          <p>更新：{{ new Date(library.detail.value.document.updatedAt).toLocaleString() }}</p>
        </ElTabPane>
      </ElTabs>
    </ElDrawer>
  </section>
</template>

<style scoped>
.document-library {
  margin-top: 22px;
  border: 1px solid var(--line-strong);
  background: var(--surface-elevated);
}
.document-library > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px;
  border-bottom: 1px solid var(--line-subtle);
}
.document-library header span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.13em;
}
.document-library h2 {
  margin: 4px 0 0;
  font-family: var(--font-editorial);
}
.document-filters {
  padding: 14px 18px 0;
  background: var(--surface-canvas);
}
.document-filters :deep(.el-input),
.document-filters :deep(.el-select) {
  width: 150px;
}
.load-more {
  display: flex;
  justify-content: center;
  padding: 14px;
  color: var(--text-tertiary);
  font-size: 10px;
}
</style>
