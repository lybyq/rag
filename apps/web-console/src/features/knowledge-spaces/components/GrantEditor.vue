<script setup lang="ts">
import type {
  AclSubjectType,
  SemanticRole,
  SpacePermission,
  UpsertSpaceGrantRequest,
} from '@rag/contracts';
import { reactive } from 'vue';

defineProps<{ submitting: boolean }>();
const emit = defineEmits<{ submit: [request: UpsertSpaceGrantRequest] }>();

const semanticRoles: readonly SemanticRole[] = [
  'KNOWLEDGE_READER',
  'KNOWLEDGE_EDITOR',
  'KNOWLEDGE_REVIEWER',
  'KNOWLEDGE_ADMIN',
  'AUDITOR',
];
const permissionOptions: readonly { label: string; value: SpacePermission }[] = [
  { label: '读取', value: 'READ' },
  { label: '维护', value: 'WRITE' },
  { label: '审核', value: 'REVIEW' },
  { label: '管理', value: 'ADMIN' },
];
const form = reactive<{
  subjectType: AclSubjectType;
  subjectId: string;
  permissions: SpacePermission[];
  reason: string;
}>({ subjectType: 'ROLE', subjectId: '', permissions: ['READ'], reason: '' });

function submit(): void {
  if (!form.subjectId.trim() || form.permissions.length === 0 || form.reason.trim().length < 2)
    return;
  emit('submit', {
    subjectType: form.subjectType,
    subjectId: form.subjectId.trim(),
    permissions: [...form.permissions],
    reason: form.reason.trim(),
  });
}
</script>

<template>
  <section class="grant-editor">
    <div class="section-heading">
      <span>NEW GRANT</span>
      <strong>新增或替换授权</strong>
    </div>
    <div class="grant-grid">
      <ElSelect v-model="form.subjectType" aria-label="授权主体类型" @change="form.subjectId = ''">
        <ElOption label="系统角色" value="ROLE" />
        <ElOption label="指定用户" value="USER" />
      </ElSelect>
      <ElSelect
        v-if="form.subjectType === 'ROLE'"
        v-model="form.subjectId"
        filterable
        placeholder="选择系统语义角色"
      >
        <ElOption v-for="role in semanticRoles" :key="role" :label="role" :value="role" />
      </ElSelect>
      <ElInput v-else v-model="form.subjectId" placeholder="输入稳定 userId" />
    </div>
    <ElCheckboxGroup v-model="form.permissions" class="permissions">
      <ElCheckbox v-for="item in permissionOptions" :key="item.value" :value="item.value">
        {{ item.label }}
      </ElCheckbox>
    </ElCheckboxGroup>
    <div class="reason-row">
      <ElInput v-model="form.reason" maxlength="300" placeholder="授权原因（审计必填）" />
      <ElButton type="primary" :loading="submitting" @click="submit">写入授权</ElButton>
    </div>
  </section>
</template>

<style scoped>
.grant-editor {
  padding: 18px;
  background: #eeeae1;
  border: 1px solid var(--line-subtle);
}
.section-heading span,
.section-heading strong {
  display: block;
}
.section-heading span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
}
.section-heading strong {
  margin-top: 5px;
  font-size: 13px;
}
.grant-grid,
.reason-row {
  display: grid;
  grid-template-columns: 136px 1fr;
  gap: 10px;
  margin-top: 14px;
}
.permissions {
  margin-top: 12px;
}
.reason-row {
  grid-template-columns: 1fr auto;
}
</style>
