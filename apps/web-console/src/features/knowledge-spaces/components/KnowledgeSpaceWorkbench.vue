<script setup lang="ts">
import type { KnowledgeSpace, SpaceGrant, UpsertSpaceGrantRequest } from '@rag/contracts';
import { ElMessage, ElMessageBox } from 'element-plus/es';
import { shallowRef } from 'vue';
import { useKnowledgeSpaces } from '../composables/useKnowledgeSpaces';
import SpaceAccessDrawer from './SpaceAccessDrawer.vue';
import SpaceEditorDialog, { type SpaceEditorSubmission } from './SpaceEditorDialog.vue';
import SpaceTable from './SpaceTable.vue';
import SpaceToolbar from './SpaceToolbar.vue';

const model = useKnowledgeSpaces();
const editorOpen = shallowRef(false);
const editorMode = shallowRef<'create' | 'edit'>('create');
const editingSpace = shallowRef<KnowledgeSpace>();

/** Element Plus 的 prompt 返回值还包含 close action，这里只提取真实字符串输入。 */
function promptValue(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('value' in result)) return undefined;
  const value = (result as { value?: unknown }).value;
  return typeof value === 'string' ? value : undefined;
}

function openCreate(): void {
  editorMode.value = 'create';
  editingSpace.value = undefined;
  editorOpen.value = true;
}

function openEdit(space: KnowledgeSpace): void {
  editorMode.value = 'edit';
  editingSpace.value = space;
  editorOpen.value = true;
}

async function submitEditor(submission: SpaceEditorSubmission): Promise<void> {
  if (submission.kind === 'create') await model.createSpace(submission.request);
  else await model.updateSpace(submission.spaceId, submission.request);
  editorOpen.value = false;
  ElMessage.success(submission.kind === 'create' ? '知识空间已创建' : '基本信息已更新');
}

async function deactivate(space: KnowledgeSpace): Promise<void> {
  const result = await ElMessageBox.prompt(
    '停用后不再用于新的检索和入库，请填写原因。',
    '停用知识空间',
    {
      confirmButtonText: '确认停用',
      cancelButtonText: '取消',
      inputPattern: /^.{2,300}$/,
      inputErrorMessage: '原因需为 2～300 个字符',
      type: 'warning',
    },
  ).catch(() => undefined);
  const reason = promptValue(result);
  if (!reason) return;
  await model.deactivateSpace(space, reason);
  ElMessage.success('知识空间已停用');
}

async function grant(request: UpsertSpaceGrantRequest): Promise<void> {
  if (!model.selectedSpace.value) return;
  await model.upsertGrant(model.selectedSpace.value.id, request);
  ElMessage.success('授权与策略版本已更新');
}

async function revoke(grantRecord: SpaceGrant): Promise<void> {
  const result = await ElMessageBox.prompt('撤权立即影响后续请求，请填写审计原因。', '撤销授权', {
    confirmButtonText: '确认撤权',
    cancelButtonText: '取消',
    inputPattern: /^.{2,300}$/,
    inputErrorMessage: '原因需为 2～300 个字符',
    type: 'warning',
  }).catch(() => undefined);
  const reason = promptValue(result);
  if (!reason || !model.selectedSpace.value) return;
  await model.revokeGrant(model.selectedSpace.value.id, grantRecord.id, { reason });
  ElMessage.success('授权已撤销，旧缓存已失效');
}
</script>

<template>
  <section class="workbench" :class="{ 'has-drawer': model.selectedSpace.value }">
    <div class="list-pane">
      <SpaceToolbar
        :search="model.filters.search"
        :status="model.filters.status"
        :loading="model.loading.value"
        :can-create="model.canCreate.value"
        @update:search="model.filters.search = $event"
        @update:status="model.filters.status = $event"
        @search="model.loadSpaces"
        @create="openCreate"
      />
      <ElAlert
        v-if="model.errorMessage.value"
        class="error-alert"
        :title="model.errorMessage.value"
        type="error"
        show-icon
        @close="model.errorMessage.value = ''"
      />
      <SpaceTable
        :items="model.spaces.value"
        :loading="model.loading.value"
        @manage="model.selectSpace"
        @edit="openEdit"
        @deactivate="deactivate"
      />
    </div>

    <SpaceAccessDrawer
      :space="model.selectedSpace.value"
      :grants="model.grants.value"
      :policy-versions="model.policyVersions.value"
      :submitting="model.mutating.value"
      @close="model.selectedSpace.value = undefined"
      @grant="grant"
      @revoke="revoke"
    />

    <SpaceEditorDialog
      v-model:open="editorOpen"
      :mode="editorMode"
      :space="editingSpace"
      :submitting="model.mutating.value"
      @submit="submitEditor"
    />
  </section>
</template>

<style scoped>
.workbench {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  margin-top: 26px;
  overflow: hidden;
  background: var(--surface-elevated);
  border: 1px solid var(--line-strong);
  box-shadow: 0 18px 50px rgb(18 27 33 / 6%);
}
.workbench.has-drawer {
  grid-template-columns: minmax(620px, 1fr) minmax(360px, 430px);
}
.list-pane {
  container-type: inline-size;
  min-width: 0;
}
.error-alert {
  border-radius: 0;
}
@media (max-width: 1250px) {
  .workbench.has-drawer {
    grid-template-columns: 1fr;
  }
  .workbench.has-drawer :deep(.access-drawer) {
    border-top: 1px solid var(--line-strong);
    border-left: 0;
  }
}
</style>
