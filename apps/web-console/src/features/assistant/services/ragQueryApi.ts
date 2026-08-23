/**
 * 浏览器到 rag-query-service 的唯一问答契约入口。
 *
 * 所有 JSON 响应都通过共享 Zod Schema 校验；身份仍由 platformApiRawFetch 统一注入，浏览器
 * 不持有模型、Milvus、MinIO 或长期凭据。SSE 使用服务端签发的 HttpOnly 一次性 Ticket。
 *
 * @requirement WEB-018
 * @requirement WEB-021
 * @requirement WEB-030
 */
import {
  CitationPreviewEnvelopeSchema,
  ConversationEnvelopeSchema,
  ConversationListEnvelopeSchema,
  ConversationMessageListEnvelopeSchema,
  CreateRagRunAcceptedEnvelopeSchema,
  MessageFeedbackEnvelopeSchema,
  RagRunEnvelopeSchema,
  RagRunStepListEnvelopeSchema,
  RetrievalDebugEnvelopeSchema,
  RagRunEventPageEnvelopeSchema,
  RunStreamTicketEnvelopeSchema,
  type Conversation,
  type ConversationMessage,
  type CreateRagRunAccepted,
  type MessageFeedback,
  type RagRun,
  type RagRunEventPage,
  type RagRunStep,
  type RetrievalDebugResult,
  type CitationPreview,
} from '@rag/contracts';
import { platformApiFetch } from '@/features/identity/services/platformApi';

/** 分页读取会话；nextCursor 由服务端生成，客户端不解析。 */
export async function listConversations(cursor?: string): Promise<{
  items: readonly Conversation[];
  nextCursor: string | null;
}> {
  const query = new URLSearchParams({ limit: '30' });
  if (cursor) query.set('cursor', cursor);
  return (await platformApiFetch(`/api/v1/conversations?${query}`, ConversationListEnvelopeSchema))
    .data;
}

/** 创建当前用户会话。 */
export async function createConversation(title?: string): Promise<Conversation> {
  return (
    await platformApiFetch('/api/v1/conversations', ConversationEnvelopeSchema, {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    })
  ).data;
}

/** 读取短窗口消息；历史引用会在服务端重新鉴权。 */
export async function listMessages(
  conversationId: string,
): Promise<readonly ConversationMessage[]> {
  return (
    await platformApiFetch(
      `/api/v1/conversations/${conversationId}/messages`,
      ConversationMessageListEnvelopeSchema,
    )
  ).data.items;
}

/** 创建异步 Run；幂等键由一次用户提交生成并在重试时复用。 */
export async function createRun(
  conversationId: string,
  question: string,
  requestedSpaceIds: readonly string[],
  idempotencyKey: string,
): Promise<CreateRagRunAccepted> {
  return (
    await platformApiFetch(
      `/api/v1/conversations/${conversationId}/runs`,
      CreateRagRunAcceptedEnvelopeSchema,
      {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ question, requestedSpaceIds }),
      },
    )
  ).data;
}

/** 签发一次性流 Ticket；Ticket 本体只进入 HttpOnly Cookie，不进入 URL。 */
export async function issueStreamTicket(runId: string): Promise<string> {
  return (
    await platformApiFetch(`/api/v1/runs/${runId}/stream-ticket`, RunStreamTicketEnvelopeSchema, {
      method: 'POST',
    })
  ).data.streamUrl;
}

/** SSE 不可用时读取真实持久化事件，不生成任何前端假进度。 */
export async function pollRunEvents(runId: string, after: number): Promise<RagRunEventPage> {
  return (
    await platformApiFetch(
      `/api/v1/runs/${runId}/events/poll?after=${after}&limit=100`,
      RagRunEventPageEnvelopeSchema,
    )
  ).data;
}

/** 用户主动取消 Run。 */
export async function cancelRun(runId: string): Promise<RagRun> {
  return (
    await platformApiFetch(`/api/v1/runs/${runId}/cancel`, RagRunEnvelopeSchema, {
      method: 'POST',
      body: JSON.stringify({ reason: '用户从问答台主动取消' }),
    })
  ).data;
}

/** 每次打开引用都重新请求服务端，绝不缓存越权后的正文。 */
export async function getCitation(citationId: string): Promise<CitationPreview> {
  return (await platformApiFetch(`/api/v1/citations/${citationId}`, CitationPreviewEnvelopeSchema))
    .data;
}

/** 保存当前用户对最终助手消息的结构化反馈；自由文本不是必填项。 */
export async function saveMessageFeedback(
  messageId: string,
  rating: 'HELPFUL' | 'NOT_HELPFUL',
): Promise<MessageFeedback> {
  return (
    await platformApiFetch(
      `/api/v1/messages/${messageId}/feedback`,
      MessageFeedbackEnvelopeSchema,
      {
        method: 'POST',
        body: JSON.stringify({ rating, tags: [], errorTypes: [] }),
      },
    )
  ).data;
}

/** 管理员/审计员执行授权后的检索调试，不返回问题和 Chunk 正文。 */
export async function runRetrievalDebug(runId: string): Promise<RetrievalDebugResult> {
  return (
    await platformApiFetch(`/api/v1/runs/${runId}/retrieval-debug`, RetrievalDebugEnvelopeSchema, {
      method: 'POST',
    })
  ).data;
}

/** 读取节点摘要，用于展示 Reranker 阶段而非模型私有内容。 */
export async function listRunSteps(runId: string): Promise<readonly RagRunStep[]> {
  return (await platformApiFetch(`/api/v1/runs/${runId}/steps`, RagRunStepListEnvelopeSchema)).data
    .items;
}
