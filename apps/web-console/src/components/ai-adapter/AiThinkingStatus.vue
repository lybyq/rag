<!-- 只展示服务端公开阶段，不展示模型私有思维链。 @requirement WEB-003 WEB-019 -->
<script setup lang="ts">
import { computed } from 'vue';
import { Thinking } from 'vue-element-plus-x';

const props = defineProps<{
  stage: string;
  state: 'idle' | 'running' | 'completed' | 'error' | 'cancelled';
}>();
const status = computed(
  () =>
    ({
      idle: 'start',
      running: 'thinking',
      completed: 'end',
      error: 'error',
      cancelled: 'cancel',
    })[props.state] as 'start' | 'thinking' | 'end' | 'error' | 'cancel',
);
</script>

<template>
  <Thinking
    :content="stage"
    :status="status"
    :model-value="state === 'running'"
    :auto-collapse="state !== 'running'"
    background-color="#f5f7fa"
    color="#475467"
  >
    <template #label>{{ stage }}</template>
    <template #content>{{ stage }}。这里只展示可公开的执行状态，不包含模型思维链。</template>
  </Thinking>
</template>
