/**
 * 问答 Run 的用户可见处理说明映射。
 *
 * 本文件把内部 LangGraph 节点与脱敏 outputSummary 转成稳定的 `run.progress` 契约。它只允许
 * 输出授权空间 ID、授权后文档数、实际上下文证据数和耗时，不输出问题、候选标题、证据正文
 * 或模型思维链。PostgreSQL 与前端共同复用该契约，避免两端各自猜节点含义。
 *
 * @requirement OPT-011
 * @requirement WEB-019
 */
import {
  RagRunProgressPayloadSchema,
  type RagRunProgressPayload,
  type RagRunStepStatus,
} from '@rag/contracts';

/** 从节点开始事实生成一条有用户价值的处理说明；内部噪声节点返回 undefined。 */
export function progressWhenStepStarts(
  nodeKey: string,
  attempt: number,
): RagRunProgressPayload | undefined {
  const mapped = startMessage(nodeKey);
  if (!mapped) return undefined;
  return RagRunProgressPayloadSchema.parse({
    ...mapped,
    status: 'RUNNING',
    attempt,
  });
}

/**
 * 从节点完成摘要生成真实数量说明。
 *
 * `outputSummary` 已由 Graph 使用白名单构造；这里仍再次做类型与范围收敛，未知字段绝不透传。
 */
export function progressWhenStepFinishes(
  nodeKey: string,
  attempt: number,
  status: Extract<RagRunStepStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'SKIPPED'>,
  outputSummary: Readonly<Record<string, unknown>>,
): RagRunProgressPayload | undefined {
  if (status !== 'SUCCEEDED') {
    const started = startMessage(nodeKey);
    return started
      ? RagRunProgressPayloadSchema.parse({
          ...started,
          status: 'FAILED',
          publicMessage: '当前处理步骤未完成，请稍后重试或联系管理员查看错误分类。',
          attempt,
          ...duration(outputSummary),
        })
      : undefined;
  }
  if (nodeKey === 'answer_retrieve' || nodeKey === 'answer_retry_retrieval') {
    const authorizedSpaceIds = uuidArray(outputSummary['authorizedSpaceIds']);
    return RagRunProgressPayloadSchema.parse({
      phase: 'RETRIEVAL',
      status: 'COMPLETED',
      publicMessage: authorizedSpaceIds.length
        ? `正在检索你选择的 ${authorizedSpaceIds.length} 个可访问知识空间。`
        : '已完成知识空间权限检查，正在检索可访问资料。',
      attempt,
      ...(authorizedSpaceIds.length ? { authorizedSpaceIds } : {}),
      ...duration(outputSummary),
    });
  }
  if (nodeKey === 'answer_expand_evidence') {
    const accessibleDocumentCount = nonNegativeInteger(outputSummary['accessibleDocumentCount']);
    return RagRunProgressPayloadSchema.parse({
      phase: 'FILTERING',
      status: 'COMPLETED',
      publicMessage:
        accessibleDocumentCount === undefined
          ? '已完成来源与权限复核，正在筛选相关资料。'
          : `已找到 ${accessibleDocumentCount} 份可访问的相关资料，正在筛选。`,
      attempt,
      ...(accessibleDocumentCount === undefined ? {} : { accessibleDocumentCount }),
      ...duration(outputSummary),
    });
  }
  if (nodeKey === 'answer_build_context') {
    const includedEvidenceCount = nonNegativeInteger(outputSummary['contextIncludedCount']);
    return RagRunProgressPayloadSchema.parse({
      phase: 'GENERATION',
      status: 'COMPLETED',
      publicMessage:
        includedEvidenceCount === undefined
          ? '已完成证据上下文构造，正在根据资料整理答案。'
          : `已保留 ${includedEvidenceCount} 条证据，正在根据资料整理答案。`,
      attempt,
      ...(includedEvidenceCount === undefined ? {} : { includedEvidenceCount }),
      ...duration(outputSummary),
    });
  }
  if (nodeKey === 'answer_final_validation') {
    return RagRunProgressPayloadSchema.parse({
      phase: 'VALIDATION',
      status: 'COMPLETED',
      publicMessage: '引用及适用条件核验完成，正在准备最终答案。',
      attempt,
      ...duration(outputSummary),
    });
  }
  return undefined;
}

function startMessage(
  nodeKey: string,
): Pick<RagRunProgressPayload, 'phase' | 'publicMessage'> | undefined {
  if (nodeKey === 'answer_retrieve') {
    return { phase: 'RETRIEVAL', publicMessage: '正在确认你选择的知识空间权限。' };
  }
  if (nodeKey === 'answer_retry_retrieval') {
    return {
      phase: 'RETRIEVAL',
      publicMessage: '首轮资料在回源复核后不足，正在权限与时限内执行第二轮检索。',
    };
  }
  if (nodeKey === 'answer_expand_evidence') {
    return { phase: 'FILTERING', publicMessage: '正在回源复核文档版本、权限与相关资料。' };
  }
  if (nodeKey === 'answer_generate_draft') {
    return { phase: 'GENERATION', publicMessage: '正在根据已保留资料整理答案。' };
  }
  if (nodeKey === 'answer_rule_validation' || nodeKey === 'answer_semantic_judge') {
    return { phase: 'VALIDATION', publicMessage: '正在核验引用及适用条件。' };
  }
  if (nodeKey === 'answer_finalize') {
    return { phase: 'FINALIZING', publicMessage: '正在发布已通过校验的答案。' };
  }
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function duration(summary: Readonly<Record<string, unknown>>): { durationMs?: number } {
  const durationMs = nonNegativeInteger(summary['durationMs']);
  return durationMs === undefined ? {} : { durationMs };
}

function uuidArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item),
  );
}
