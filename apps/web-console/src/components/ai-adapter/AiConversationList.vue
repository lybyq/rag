<!--
  Element Plus X Conversations 的稳定项目适配层。
  业务页只接收企业会话类型，不依赖第三方 rowKey、labelKey 或 change 事件细节。
  @requirement WEB-003 WEB-004 WEB-018
-->
<script setup lang="ts">
import type { Conversation } from '@rag/contracts';
import { Conversations } from 'vue-element-plus-x';

defineProps<{
  items: readonly Conversation[];
  activeId?: string;
  loading?: boolean;
}>();
const emit = defineEmits<{ select: [conversationId: string]; loadMore: [] }>();

function select(item: unknown): void {
  if (typeof item === 'object' && item && 'id' in item && typeof item.id === 'string') {
    emit('select', item.id);
  }
}
</script>

<template>
  <Conversations
    :items="[...items]"
    :active="activeId"
    row-key="id"
    label-key="title"
    :load-more="() => emit('loadMore')"
    :load-more-loading="loading"
    :show-tooltip="true"
    :label-max-width="190"
    @change="select"
  >
    <template #header><slot name="header" /></template>
    <template #label="{ item }">
      <div class="conversation-label">
        <strong>{{ item.title }}</strong>
        <small>{{ item.status === 'ARCHIVED' ? '已归档' : '最近更新' }}</small>
      </div>
    </template>
  </Conversations>
</template>

<style scoped>
.conversation-label {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.conversation-label strong {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conversation-label small {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
/* 让 Element Plus X 的会话项铺满侧栏宽度并采用 Dify 蓝调选中态。 */
:deep(.elx-conversations) {
  --elx-conversations-list-auto-bg-color: var(--surface-elevated);
  width: 100%;
}
:deep(.elx-conversations-item) {
  margin-right: 0;
  border-radius: 8px;
}
:deep(.elx-conversations-item--active),
:deep(.elx-conversations-item--hovered),
:deep(.elx-conversations-item:hover) {
  background-color: var(--accent-050);
}
:deep(.elx-conversations-item--active .elx-conversations-item__label) {
  color: var(--accent-700);
  font-weight: 600;
}
</style>
