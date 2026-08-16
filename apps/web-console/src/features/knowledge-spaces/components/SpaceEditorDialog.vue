<script setup lang="ts">
import type {
  CreateKnowledgeSpaceRequest,
  KnowledgeSpace,
  UpdateKnowledgeSpaceRequest,
} from '@rag/contracts';
import type { FormInstance, FormRules } from 'element-plus';
import { reactive, shallowRef, watch } from 'vue';

export type SpaceEditorSubmission =
  | { kind: 'create'; request: CreateKnowledgeSpaceRequest }
  | { kind: 'update'; spaceId: string; request: UpdateKnowledgeSpaceRequest };

const props = defineProps<{
  open: boolean;
  mode: 'create' | 'edit';
  space?: KnowledgeSpace;
  submitting: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  submit: [submission: SpaceEditorSubmission];
}>();

const formRef = shallowRef<FormInstance>();
const form = reactive({ code: '', name: '', description: '', ownerUserId: '' });
const rules: FormRules = {
  code: [
    { required: true, message: '请输入空间编码', trigger: 'blur' },
    { pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, message: '使用小写 kebab-case', trigger: 'blur' },
  ],
  name: [{ required: true, min: 2, max: 80, message: '名称需为 2～80 个字符', trigger: 'blur' }],
};

/** 每次打开都从 props 重新建立草稿，不修改列表中的服务端对象。 */
watch(
  () => [props.open, props.mode, props.space] as const,
  ([open, mode, space]) => {
    if (!open) return;
    form.code = mode === 'edit' ? (space?.code ?? '') : '';
    form.name = mode === 'edit' ? (space?.name ?? '') : '';
    form.description = mode === 'edit' ? (space?.description ?? '') : '';
    form.ownerUserId = '';
    formRef.value?.clearValidate();
  },
);

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  if (props.mode === 'create') {
    emit('submit', {
      kind: 'create',
      request: {
        code: form.code.trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        ...(form.ownerUserId.trim() ? { ownerUserId: form.ownerUserId.trim() } : {}),
      },
    });
    return;
  }
  if (!props.space) return;
  emit('submit', {
    kind: 'update',
    spaceId: props.space.id,
    request: {
      expectedVersion: props.space.version,
      name: form.name.trim(),
      description: form.description.trim() || null,
    },
  });
}
</script>

<template>
  <ElDialog
    :model-value="open"
    :title="mode === 'create' ? '新建知识空间' : '编辑基本信息'"
    width="min(560px, 92vw)"
    destroy-on-close
    @update:model-value="emit('update:open', $event)"
  >
    <ElForm ref="formRef" :model="form" :rules="rules" label-position="top">
      <ElFormItem label="空间编码" prop="code">
        <ElInput v-model="form.code" :disabled="mode === 'edit'" placeholder="例如 hr-policy" />
      </ElFormItem>
      <ElFormItem label="空间名称" prop="name">
        <ElInput v-model="form.name" maxlength="80" show-word-limit />
      </ElFormItem>
      <ElFormItem label="用途说明">
        <ElInput
          v-model="form.description"
          type="textarea"
          :rows="3"
          maxlength="500"
          show-word-limit
        />
      </ElFormItem>
      <ElFormItem v-if="mode === 'create'" label="负责人 userId（可选）">
        <ElInput
          v-model="form.ownerUserId"
          placeholder="默认使用当前用户；仅系统管理员可指定他人"
        />
      </ElFormItem>
    </ElForm>
    <template #footer>
      <ElButton @click="emit('update:open', false)">取消</ElButton>
      <ElButton type="primary" :loading="submitting" @click="submit">保存</ElButton>
    </template>
  </ElDialog>
</template>
