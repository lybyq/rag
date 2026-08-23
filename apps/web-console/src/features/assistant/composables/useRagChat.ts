/**
 * 问答台的会话、真实 Run、SSE 续传、轮询降级、取消和引用编排。
 *
 * 这里不生成答案、不伪造阶段百分比，也不解析模型私有过程；状态仅来自服务端持久化事件。
 * EventSource 断开后先重新签发一次性 Ticket，连续失败才转为 sequence 游标轮询。
 *
 * @requirement WEB-018
 * @requirement WEB-019
 * @requirement WEB-021
 * @requirement WEB-022
 * @requirement WEB-027
 */
import {
  KnowledgeSpaceListEnvelopeSchema,
  RagRunEventSchema,
  type CitationPreview,
  type Conversation,
  type ConversationMessage,
  type KnowledgeSpace,
  type RagRun,
  type RagRunEvent,
} from '@rag/contracts';
import {
  computed,
  onMounted,
  onScopeDispose,
  shallowRef,
  type ComputedRef,
  type ShallowRef,
} from 'vue';
import { platformApiFetch } from '@/features/identity/services/platformApi';
import {
  cancelRun,
  createConversation,
  createRun,
  getCitation,
  issueStreamTicket,
  listConversations,
  listMessages,
  pollRunEvents,
  saveMessageFeedback,
} from '../services/ragQueryApi';

const streamEventTypes = [
  'run.accepted',
  'run.started',
  'run.step_started',
  'run.step_completed',
  'run.cancel_requested',
  'run.cancelled',
  'run.failed',
  'run.expired',
  'answer.completed',
  'stream.expired',
] as const;
const terminalStatuses = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);

/** 问答 Feature 对页面公开的稳定状态与命令。 */
export interface RagChatComposable {
  readonly conversations: ShallowRef<readonly Conversation[]>;
  readonly spaces: ShallowRef<readonly KnowledgeSpace[]>;
  readonly messages: ShallowRef<readonly ConversationMessage[]>;
  readonly selectedConversationId: ShallowRef<string>;
  readonly selectedSpaceIds: ShallowRef<string[]>;
  readonly selectedMode: ShallowRef<'STRICT_EVIDENCE'>;
  readonly currentRun: ShallowRef<RagRun | undefined>;
  readonly stage: ShallowRef<string>;
  readonly streamState: ShallowRef<'idle' | 'connecting' | 'live' | 'polling' | 'closed'>;
  readonly loading: ShallowRef<boolean>;
  readonly running: ComputedRef<boolean>;
  readonly executionState: ComputedRef<'idle' | 'running' | 'completed' | 'error' | 'cancelled'>;
  readonly errorMessage: ShallowRef<string>;
  readonly citation: ShallowRef<CitationPreview | undefined>;
  readonly citationLoading: ShallowRef<boolean>;
  readonly feedbackByMessageId: ShallowRef<Readonly<Record<string, 'HELPFUL' | 'NOT_HELPFUL'>>>;
  readonly initialize: () => Promise<void>;
  readonly loadMoreConversations: () => Promise<void>;
  readonly selectConversation: (conversationId: string) => Promise<void>;
  readonly submit: (question: string) => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly openCitation: (citationId: string) => Promise<void>;
  readonly feedback: (messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL') => Promise<void>;
}

/** 创建问答页面所需的全部响应式状态和命令。 */
export function useRagChat(): RagChatComposable {
  const conversations = shallowRef<readonly Conversation[]>([]);
  const spaces = shallowRef<readonly KnowledgeSpace[]>([]);
  const messages = shallowRef<readonly ConversationMessage[]>([]);
  const selectedConversationId = shallowRef('');
  const selectedSpaceIds = shallowRef<string[]>([]);
  /** 当前产品只开放经过最终校验的严格证据模式；保留显式状态，后续模式不能靠页面暗中切换。 */
  const selectedMode = shallowRef<'STRICT_EVIDENCE'>('STRICT_EVIDENCE');
  const nextCursor = shallowRef<string | null>(null);
  const currentRun = shallowRef<RagRun>();
  const stage = shallowRef('等待提问');
  const streamState = shallowRef<'idle' | 'connecting' | 'live' | 'polling' | 'closed'>('idle');
  const loading = shallowRef(false);
  const errorMessage = shallowRef('');
  const citation = shallowRef<CitationPreview>();
  const citationLoading = shallowRef(false);
  const feedbackByMessageId = shallowRef<Readonly<Record<string, 'HELPFUL' | 'NOT_HELPFUL'>>>({});
  let eventSource: EventSource | undefined;
  let cursor = 0;
  let generation = 0;
  let reconnects = 0;

  const running = computed(() =>
    currentRun.value ? !terminalStatuses.has(currentRun.value.status) : false,
  );
  const executionState = computed<'idle' | 'running' | 'completed' | 'error' | 'cancelled'>(() => {
    if (!currentRun.value) return 'idle';
    if (['ACCEPTED', 'RUNNING', 'CANCELLING'].includes(currentRun.value.status)) return 'running';
    if (currentRun.value.status === 'COMPLETED') return 'completed';
    if (currentRun.value.status === 'CANCELLED') return 'cancelled';
    return 'error';
  });

  async function initialize(): Promise<void> {
    loading.value = true;
    errorMessage.value = '';
    try {
      const [conversationPage, spaceEnvelope] = await Promise.all([
        listConversations(),
        platformApiFetch('/api/v1/spaces', KnowledgeSpaceListEnvelopeSchema),
      ]);
      conversations.value = conversationPage.items;
      nextCursor.value = conversationPage.nextCursor;
      spaces.value = spaceEnvelope.data.items.filter((item) => item.status === 'ACTIVE');
      selectedSpaceIds.value = spaces.value.slice(0, 1).map((item) => item.id);
      const first = conversations.value[0];
      if (first) await selectConversation(first.id);
    } catch (error: unknown) {
      errorMessage.value = readableError(error, '问答台初始化失败');
    } finally {
      loading.value = false;
    }
  }

  async function loadMoreConversations(): Promise<void> {
    if (!nextCursor.value || loading.value) return;
    loading.value = true;
    try {
      const page = await listConversations(nextCursor.value);
      conversations.value = [...conversations.value, ...page.items];
      nextCursor.value = page.nextCursor;
    } finally {
      loading.value = false;
    }
  }

  async function selectConversation(conversationId: string): Promise<void> {
    selectedConversationId.value = conversationId;
    messages.value = await listMessages(conversationId);
  }

  async function submit(question: string): Promise<void> {
    if (running.value || selectedSpaceIds.value.length === 0) return;
    errorMessage.value = '';
    loading.value = true;
    try {
      let conversationId = selectedConversationId.value;
      if (!conversationId) {
        const conversation = await createConversation(question.slice(0, 40));
        conversations.value = [conversation, ...conversations.value];
        conversationId = conversation.id;
        selectedConversationId.value = conversation.id;
      }
      const accepted = await createRun(
        conversationId,
        question,
        selectedSpaceIds.value,
        crypto.randomUUID(),
      );
      currentRun.value = accepted.run;
      stage.value = '请求已接受，等待 LangGraph 执行';
      cursor = 0;
      reconnects = 0;
      messages.value = await listMessages(conversationId);
      await connectStream(accepted.run.id, ++generation);
    } catch (error: unknown) {
      errorMessage.value = readableError(error, '提问失败');
    } finally {
      loading.value = false;
    }
  }

  async function connectStream(runId: string, expectedGeneration: number): Promise<void> {
    streamState.value = 'connecting';
    const streamUrl = await issueStreamTicket(runId);
    if (generation !== expectedGeneration) return;
    eventSource?.close();
    const source = new EventSource(streamUrl, { withCredentials: true });
    eventSource = source;
    source.onopen = () => {
      reconnects = 0;
      streamState.value = 'live';
    };
    for (const eventType of streamEventTypes) {
      source.addEventListener(eventType, (event) => {
        const parsed = parseSseEvent(event);
        if (parsed && parsed.sequence > cursor) {
          cursor = parsed.sequence;
          void applyEvent(parsed);
        }
      });
    }
    source.onerror = () => {
      source.close();
      if (generation !== expectedGeneration || !running.value) return;
      reconnects += 1;
      if (reconnects <= 2) {
        streamState.value = 'connecting';
        void delay(600)
          .then(() => connectStream(runId, expectedGeneration))
          .catch(() => startPolling(runId, expectedGeneration));
      } else {
        void startPolling(runId, expectedGeneration);
      }
    };
  }

  async function startPolling(runId: string, expectedGeneration: number): Promise<void> {
    eventSource?.close();
    streamState.value = 'polling';
    while (generation === expectedGeneration && running.value) {
      try {
        const page = await pollRunEvents(runId, cursor);
        for (const event of page.items) {
          if (event.sequence > cursor) {
            cursor = event.sequence;
            await applyEvent(event);
          }
        }
        currentRun.value = page.run;
        if (terminalStatuses.has(page.run.status)) break;
      } catch (error: unknown) {
        errorMessage.value = readableError(error, '事件流暂时中断');
      }
      await delay(1_500);
    }
    streamState.value = 'closed';
  }

  async function applyEvent(event: RagRunEvent): Promise<void> {
    stage.value = publicStage(event);
    if (
      ['answer.completed', 'run.failed', 'run.cancelled', 'run.expired'].includes(event.eventType)
    ) {
      streamState.value = 'closed';
      eventSource?.close();
      if (selectedConversationId.value)
        messages.value = await listMessages(selectedConversationId.value);
      const status = typeof event.payload.status === 'string' ? event.payload.status : undefined;
      if (currentRun.value && status)
        currentRun.value = { ...currentRun.value, status: status as RagRun['status'] };
    }
  }

  async function cancel(): Promise<void> {
    if (!currentRun.value || !running.value) return;
    currentRun.value = await cancelRun(currentRun.value.id);
    stage.value = '取消请求已提交，等待当前节点安全停止';
  }

  async function openCitation(citationId: string): Promise<void> {
    citationLoading.value = true;
    citation.value = undefined;
    try {
      citation.value = await getCitation(citationId);
    } catch (error: unknown) {
      errorMessage.value = readableError(error, '引用已失效或当前身份无权查看');
    } finally {
      citationLoading.value = false;
    }
  }

  /** 反馈写回服务端评测事实；失败时保留可行动错误，不在浏览器伪造成功。 */
  async function feedback(messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL'): Promise<void> {
    try {
      const saved = await saveMessageFeedback(messageId, rating);
      feedbackByMessageId.value = { ...feedbackByMessageId.value, [messageId]: saved.rating };
    } catch (error: unknown) {
      errorMessage.value = readableError(error, '反馈保存失败');
    }
  }

  onMounted(() => void initialize());
  onScopeDispose(() => {
    generation += 1;
    eventSource?.close();
  });

  return {
    conversations,
    spaces,
    messages,
    selectedConversationId,
    selectedSpaceIds,
    selectedMode,
    currentRun,
    stage,
    streamState,
    loading,
    running,
    executionState,
    errorMessage,
    citation,
    citationLoading,
    feedbackByMessageId,
    initialize,
    loadMoreConversations,
    selectConversation,
    submit,
    cancel,
    openCitation,
    feedback,
  };
}

function parseSseEvent(event: Event): RagRunEvent | undefined {
  if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return undefined;
  try {
    const parsed = RagRunEventSchema.safeParse(JSON.parse(event.data) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function publicStage(event: RagRunEvent): string {
  if (event.eventType === 'run.accepted') return '请求已持久化';
  if (event.eventType === 'run.started') return 'LangGraph 已启动';
  if (event.eventType === 'run.cancel_requested') return '正在安全取消';
  if (event.eventType === 'run.cancelled') return '已取消';
  if (event.eventType === 'run.failed') return '执行失败，可使用 Trace ID 排查';
  if (event.eventType === 'run.expired') return '执行超过绝对 Deadline';
  if (event.eventType === 'answer.completed') return '答案已通过校验并发布';
  if (event.eventType === 'run.step_started') {
    const node = typeof event.payload.nodeKey === 'string' ? event.payload.nodeKey : 'graph-node';
    return `正在执行：${node}`;
  }
  if (event.eventType === 'run.step_completed') return '节点完成，继续下一阶段';
  return '正在同步执行状态';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
