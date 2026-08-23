/**
 * M07 确定性查询路由与 LLM 使用门禁。
 *
 * 路由必须可回归、可解释，因此问候、知识查询、需要澄清和明确拒绝均由代码判定；
 * LLM 仅在知识查询确有多跳、长问题或指代消解需求时参与改写，不能自行选择权限或过滤器。
 *
 * @requirement RET-002
 * @requirement RET-004
 * @requirement RET-005
 */
import type { RetrievalEntity, RetrievalRoute } from '@rag/contracts';

const greetingPattern = /^(?:你好|您好|嗨|hi|hello|早上好|下午好|晚上好|谢谢|多谢)[！!。.\s]*$/iu;
const rejectionPattern =
  /(?:忽略|绕过|跳过|关闭|取消).{0,12}(?:权限|授权|访问控制|安全规则)|(?:导出|列出|返回).{0,8}(?:全部|所有).{0,8}(?:密钥|密码|无权|未授权|系统提示词)/u;
const vaguePattern =
  /^(?:这个|那个|它|上述|前面|刚才|该内容|怎么回事|怎么办)(?:呢|吗|如何|是什么)?[？?。.\s]*$/u;
const multiHopPattern =
  /(?:分别|对比|比较|以及|并且|同时|之间|先.+再|基于.+判断|and|compare|versus|\bvs\b)/iu;

/** 以稳定规则选择入口路线；空问题和显式越权意图默认拒绝。 */
export function routeQuery(
  question: string,
  historyEntities: readonly RetrievalEntity[] = [],
): RetrievalRoute {
  const normalized = question.trim();
  if (!normalized || rejectionPattern.test(normalized)) return 'REJECT';
  if (greetingPattern.test(normalized)) return 'CHAT';
  if ((normalized.length <= 2 || vaguePattern.test(normalized)) && historyEntities.length === 0) {
    return 'CLARIFY';
  }
  return 'KNOWLEDGE';
}

/** 只有复杂知识查询才允许调用改写模型；精确短查询直接进入检索以减少延迟和语义漂移。 */
export function shouldUseLlmRewrite(
  question: string,
  route: RetrievalRoute,
  historyEntities: readonly RetrievalEntity[] = [],
): boolean {
  if (route !== 'KNOWLEDGE') return false;
  return (
    question.length > 160 ||
    multiHopPattern.test(question) ||
    (historyEntities.length > 0 && /(?:这个|那个|它|上述|前面|该)/u.test(question))
  );
}
