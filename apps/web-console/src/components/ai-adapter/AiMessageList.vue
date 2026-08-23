<!--
  BubbleList 适配层：Markdown 禁止原始 HTML，引用 UUID 转为可键盘点击的按钮。
  @requirement WEB-003 WEB-004 WEB-020 WEB-021 WEB-027
-->
<script setup lang="ts">
/* eslint-disable vue/no-v-html -- markdown-it 禁用原始 HTML，引用按钮仅由 UUID 白名单模板生成。 */
import type { ConversationMessage } from '@rag/contracts';
import MarkdownIt from 'markdown-it';
import { computed } from 'vue';
import { BubbleList } from 'vue-element-plus-x';
import type { BubbleListItemProps } from 'vue-element-plus-x/types/BubbleList';

type ChatBubble = Omit<ConversationMessage, 'content'> &
  BubbleListItemProps & { content: string; role: ConversationMessage['role'] };

const props = defineProps<{
  items: readonly ConversationMessage[];
  feedback?: Readonly<Record<string, 'HELPFUL' | 'NOT_HELPFUL'>>;
}>();
const emit = defineEmits<{
  citation: [citationId: string];
  copy: [content: string];
  feedback: [messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL'];
}>();
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
const citationPattern =
  /\[([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/giu;

const bubbles = computed<ChatBubble[]>(() =>
  props.items
    .filter((item) => item.status !== 'DELETED')
    .map((item) => ({
      ...item,
      content: item.content ?? '内容已按保留策略清理',
      placement: item.role === 'USER' ? ('end' as const) : ('start' as const),
    })),
);

function rendered(content: string | undefined): string {
  const html = markdown.render(content ?? '内容已按保留策略清理');
  return html.replace(
    citationPattern,
    (_match, id: string) =>
      `<button class="citation-marker" type="button" data-citation-id="${id}">证据</button>`,
  );
}

function onContentClick(event: globalThis.MouseEvent): void {
  const target =
    event.target instanceof globalThis.Element
      ? event.target.closest<globalThis.HTMLElement>('[data-citation-id]')
      : null;
  if (target?.dataset.citationId) emit('citation', target.dataset.citationId);
}

/** 用户可见状态只读取持久化 citationsSummary 的白名单枚举。 */
function answerStatus(item: ConversationMessage): string | undefined {
  const value = item.citationsSummary?.status;
  return typeof value === 'string' &&
    ['ANSWERED', 'PARTIAL', 'CLARIFICATION', 'CONFLICT', 'REJECTED'].includes(value)
    ? value
    : undefined;
}

function answerStatusLabel(status: string): string {
  return (
    {
      ANSWERED: '证据充分',
      PARTIAL: '部分回答',
      CLARIFICATION: '需要澄清',
      CONFLICT: '来源冲突',
      REJECTED: '证据不足，已拒答',
    }[status] ?? status
  );
}
</script>

<template>
  <BubbleList
    :list="bubbles"
    item-key="id"
    max-height="calc(100vh - 330px)"
    :auto-scroll="true"
    :show-back-button="true"
  >
    <template #header="{ item }">
      <span class="message-role">{{
        item.role === 'USER' ? '你' : item.role === 'SYSTEM' ? '系统' : '知识助手'
      }}</span>
    </template>
    <template #content="{ item }">
      <div>
        <div
          v-if="item.role === 'ASSISTANT' && answerStatus(item)"
          class="answer-status"
          :class="`is-${answerStatus(item)?.toLowerCase()}`"
          role="status"
        >
          {{ answerStatusLabel(answerStatus(item)!) }}
        </div>
        <div
          v-if="item.role === 'ASSISTANT' && item.citationsSummary?.degraded === true"
          class="answer-status is-degraded"
          role="status"
        >
          已安全降级，建议核对引用
        </div>
        <!-- markdown-it 已关闭原始 HTML，随后只注入通过 UUID 正则校验的固定引用按钮。 -->
        <article
          class="markdown-body"
          :class="`is-${item.role.toLowerCase()}`"
          @click="onContentClick"
          v-html="rendered(item.content)"
        />
      </div>
    </template>
    <template #footer="{ item }">
      <button
        v-if="item.content"
        class="copy-action"
        type="button"
        @click="emit('copy', item.content)"
      >
        复制
      </button>
      <template v-if="item.role === 'ASSISTANT' && item.status === 'VISIBLE'">
        <button
          class="feedback-action"
          type="button"
          :class="{ 'is-active': props.feedback?.[item.id] === 'HELPFUL' }"
          :aria-pressed="props.feedback?.[item.id] === 'HELPFUL'"
          :aria-label="`这条回答有帮助：${item.id}`"
          @click="emit('feedback', item.id, 'HELPFUL')"
        >
          有帮助
        </button>
        <button
          class="feedback-action"
          type="button"
          :class="{ 'is-active': props.feedback?.[item.id] === 'NOT_HELPFUL' }"
          :aria-pressed="props.feedback?.[item.id] === 'NOT_HELPFUL'"
          :aria-label="`这条回答需改进：${item.id}`"
          @click="emit('feedback', item.id, 'NOT_HELPFUL')"
        >
          需改进
        </button>
      </template>
    </template>
  </BubbleList>
</template>

<style scoped>
.message-role {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
}
.markdown-body {
  min-width: min(620px, 70vw);
  padding: 13px 15px;
  border: 1px solid var(--line-subtle);
  background: #fff;
  color: var(--text-primary);
  line-height: 1.7;
}
.answer-status {
  width: fit-content;
  margin-bottom: 5px;
  padding: 3px 7px;
  border: 1px solid var(--line-strong);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 9px;
}
.answer-status.is-partial,
.answer-status.is-conflict,
.answer-status.is-clarification,
.answer-status.is-degraded {
  border-color: var(--warning-500, #b7791f);
  color: #8a5612;
}
.answer-status.is-rejected {
  border-color: var(--danger-500, #b54444);
  color: #9e3030;
}
.markdown-body.is-user {
  min-width: 0;
  background: var(--ink-900);
  color: #fff;
  border-color: var(--ink-900);
}
.markdown-body :deep(p) {
  margin: 0 0 8px;
}
.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-body :deep(pre) {
  overflow: auto;
  padding: 12px;
  background: #10191f;
  color: #eef2ef;
}
.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  padding: 7px;
  border: 1px solid var(--line-subtle);
  text-align: left;
}
.markdown-body :deep(.citation-marker) {
  margin: 0 2px;
  padding: 1px 6px;
  border: 1px solid var(--accent-400);
  background: var(--accent-050);
  color: var(--accent-700);
  cursor: pointer;
  font-size: 10px;
}
.copy-action {
  padding: 3px 0;
  border: 0;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 10px;
}
.feedback-action {
  margin-left: 10px;
  padding: 3px 0;
  border: 0;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 10px;
}
.feedback-action.is-active {
  color: var(--accent-700);
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
