<!-- 企业知识问答工作台；Route View 只组合本组件。 @requirement WEB-018 WEB-019 WEB-022 WEB-029 -->
<script setup lang="ts">
/* eslint-disable vue/html-indent -- Prettier 对跨行中文 small 文本使用兼容缩进。 */
import { ElMessage } from 'element-plus/es';
import { ref } from 'vue';
import AiConversationList from '@/components/ai-adapter/AiConversationList.vue';
import AiMessageList from '@/components/ai-adapter/AiMessageList.vue';
import AiSender from '@/components/ai-adapter/AiSender.vue';
import AiThinkingStatus from '@/components/ai-adapter/AiThinkingStatus.vue';
import { useRagChat } from '../composables/useRagChat';
import CitationDrawer from './CitationDrawer.vue';

const chat = useRagChat();
const citationOpen = ref(false);

async function openCitation(citationId: string): Promise<void> {
  citationOpen.value = true;
  await chat.openCitation(citationId);
}

async function copy(content: string): Promise<void> {
  await globalThis.navigator.clipboard.writeText(content);
  ElMessage.success('答案已复制');
}
</script>

<template>
  <section class="assistant-workbench" aria-label="企业知识问答台">
    <aside class="conversation-pane">
      <div class="pane-heading">
        <span>CONVERSATIONS</span>
        <strong>我的会话</strong>
      </div>
      <AiConversationList
        :items="chat.conversations.value"
        :active-id="chat.selectedConversationId.value"
        :loading="chat.loading.value"
        @select="chat.selectConversation"
        @load-more="chat.loadMoreConversations"
      />
    </aside>

    <div class="answer-pane">
      <header class="assistant-toolbar">
        <div>
          <span>STRICT EVIDENCE MODE</span>
          <h1>企业知识问答</h1>
        </div>
        <div class="scope-controls">
          <ElSelect
            v-model="chat.selectedSpaceIds.value"
            multiple
            collapse-tags
            :max-collapse-tags="2"
            placeholder="选择知识空间"
            aria-label="选择知识空间"
          >
            <ElOption
              v-for="space in chat.spaces.value"
              :key="space.id"
              :label="space.name"
              :value="space.id"
            />
          </ElSelect>
          <ElSelect v-model="chat.selectedMode.value" aria-label="回答模式">
            <ElOption label="严格证据（校验后发布）" value="STRICT_EVIDENCE" />
          </ElSelect>
        </div>
      </header>

      <ElAlert
        v-if="chat.errorMessage.value"
        :title="chat.errorMessage.value"
        type="error"
        show-icon
        :closable="false"
      >
        <template #default><ElButton text @click="chat.initialize">重试</ElButton></template>
      </ElAlert>

      <div v-if="chat.messages.value.length === 0 && !chat.loading.value" class="welcome-panel">
        <span>ASK WITH EVIDENCE</span>
        <h2>从制度、流程和业务知识中得到可追溯答案</h2>
        <p>系统会先鉴权，再规划、检索、重排、构建证据并校验答案。没有足够证据时会澄清或拒答。</p>
        <div class="welcome-prompts">
          <button
            type="button"
            @click="chat.submit('请概括当前知识空间中最重要的制度及其生效范围')"
          >
            制度摘要
          </button>
          <button type="button" @click="chat.submit('请说明相关业务流程、适用角色和关键审批节点')">
            流程追问
          </button>
        </div>
      </div>
      <AiMessageList
        v-else
        :items="chat.messages.value"
        :feedback="chat.feedbackByMessageId.value"
        max-height="100%"
        @citation="openCitation"
        @copy="copy"
        @feedback="chat.feedback"
      />

      <footer class="composer-area">
        <div v-if="chat.currentRun.value" class="run-strip">
          <AiThinkingStatus
            :stage="chat.stage.value"
            :state="chat.executionState.value"
            :timeline="chat.timeline.value"
            :elapsed-seconds="chat.elapsedSeconds.value"
            :slow-notice="chat.slowNoticeVisible.value"
          />
          <span class="transport-state">{{
            chat.streamState.value === 'polling'
              ? 'SSE 断开 · 轮询恢复中'
              : `事件通道：${chat.streamState.value}`
          }}</span>
          <ElButton v-if="chat.running.value" type="danger" plain @click="chat.cancel">
            取消运行
          </ElButton>
        </div>
        <AiSender
          :loading="chat.running.value"
          :disabled="chat.selectedSpaceIds.value.length === 0"
          @submit="chat.submit"
          @cancel="chat.cancel"
        />
        <small
          >回答正文仅在引用与校验通过后一次性发布；界面不展示系统
          Prompt、隐藏候选或私有思维链。</small
        >
      </footer>
    </div>

    <CitationDrawer
      :open="citationOpen"
      :loading="chat.citationLoading.value"
      :citation="chat.citation.value"
      @close="
        citationOpen = false;
        chat.citation.value = undefined;
      "
    />
  </section>
</template>

<style scoped>
/* 占满 .page-stage 剩余高度并锁死，让 BubbleList 的 height:100% 能收敛、消息区内部滚动。 */
.assistant-workbench {
  height: calc(100vh - 146px);
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--line-subtle);
  border-radius: 16px;
  background: var(--surface-elevated);
  box-shadow:
    0 1px 3px rgb(16 24 40 / 4%),
    0 1px 2px rgb(16 24 40 / 3%);
}
.conversation-pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 20px 16px;
  border-right: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
  overflow: hidden;
}
.pane-heading {
  display: grid;
  gap: 4px;
  padding: 0 8px 16px;
}
.pane-heading span,
.assistant-toolbar span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.13em;
}
.pane-heading strong {
  font-family: var(--font-sans);
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
}
/* Conversations 组件需要定高父级才能滚动；占满剩余空间。 */
.conversation-pane :deep(.elx-conversations) {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-shadow: none;
}
.answer-pane {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--surface-canvas);
}
.assistant-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 28px;
  border-bottom: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
}
.assistant-toolbar h1 {
  margin: 4px 0 0;
  font-family: var(--font-sans);
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}
.scope-controls {
  min-width: 330px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.scope-controls :deep(.el-select) {
  flex: 1;
}
/* 中间消息区：定高、内部滚动，避免撑破布局与输入框重叠。 */
.answer-pane :deep(.elx-bubble-list) {
  height: 100%;
}
.welcome-panel {
  align-self: center;
  justify-self: center;
  max-width: 680px;
  margin: auto;
  padding: 48px 40px;
  text-align: center;
}
.welcome-panel > span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.15em;
}
.welcome-panel h2 {
  margin: 14px 0;
  font-family: var(--font-sans);
  font-size: clamp(22px, 2.6vw, 32px);
  font-weight: 700;
  line-height: 1.3;
  color: var(--text-primary);
}
.welcome-panel p {
  color: var(--text-secondary);
  line-height: 1.8;
}
.welcome-prompts {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 24px;
}
.welcome-prompts button {
  padding: 10px 18px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-elevated);
  color: var(--text-primary);
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: 13px;
  transition:
    border-color 0.18s ease,
    background 0.18s ease,
    color 0.18s ease;
}
.welcome-prompts button:hover {
  border-color: var(--accent-400);
  background: var(--accent-050);
  color: var(--accent-700);
}
.composer-area {
  padding: 14px 28px 18px;
  border-top: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
}
.composer-area > small {
  display: block;
  margin-top: 8px;
  color: var(--text-tertiary);
  font-size: 10px;
  text-align: center;
}
.run-strip {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.transport-state {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
@media (max-width: 980px) {
  .assistant-workbench {
    grid-template-columns: 1fr;
  }
  .conversation-pane {
    display: none;
  }
  .assistant-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }
  .scope-controls {
    min-width: 0;
    width: 100%;
  }
}
</style>
