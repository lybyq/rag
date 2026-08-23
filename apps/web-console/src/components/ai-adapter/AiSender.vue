<!-- Element Plus X XSender 的项目适配层。 @requirement WEB-003 WEB-004 WEB-018 -->
<script setup lang="ts">
import { ref } from 'vue';
import { XSender } from 'vue-element-plus-x';

interface SenderExpose {
  getModelValue(): { text: string };
  clear(): void;
  focus(): void;
}

defineProps<{ loading?: boolean; disabled?: boolean; placeholder?: string }>();
const emit = defineEmits<{ submit: [value: string]; cancel: [] }>();
const sender = ref<SenderExpose>();

function submit(): void {
  const value = sender.value?.getModelValue().text.trim() ?? '';
  if (!value) return;
  emit('submit', value);
  sender.value?.clear();
}

defineExpose({ focus: () => sender.value?.focus() });
</script>

<template>
  <XSender
    ref="sender"
    :loading="loading"
    :disabled="disabled"
    :placeholder="placeholder ?? '输入需要企业知识支持的问题，Enter 发送，Shift+Enter 换行'"
    submit-type="enter"
    :max-length="20000"
    :tip-config="false"
    @submit="submit"
    @cancel="emit('cancel')"
  />
</template>
