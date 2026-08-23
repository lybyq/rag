/**
 * 证据、生成与答案校验 后台执行用例。
 *
 * 本服务把数据库领取的 Run 从 ACCEPTED 推进到 RUNNING，调用答案 LangGraph，并且只把
 * `FinalAnswer` 渲染结果、最终引用和校验事实交给同一事务完成。任何节点异常都映射为稳定终态，
 * Provider 原始错误、问题正文和证据正文不会进入事件。
 *
 * @requirement ANS-014
 * @requirement ANS-015
 * @requirement ANS-016
 * @requirement ANS-017
 */
import type {
  AccessContext,
  ClaimedRagRunExecution,
  RagRunLifecycleService,
} from '@rag/application';
import { renderFinalAnswer } from '@rag/answer';
import type { RagRun } from '@rag/contracts';
import {
  createAnswerGenerationGraph,
  type AnswerGenerationGraphDependencies,
  type AnswerGenerationStageAudit,
} from './answer-generation.graph';

/** 完成审计需要补充的模型身份配置。 */
export interface AnswerExecutionFactsConfig {
  readonly llmModelId: string;
}

/** 后台 Run 的单次完整执行入口。 */
export class AnswerGenerationExecutionService {
  private readonly graph: ReturnType<typeof createAnswerGenerationGraph>;

  public constructor(
    dependencies: AnswerGenerationGraphDependencies,
    private readonly lifecycle: RagRunLifecycleService,
    private readonly factsConfig: AnswerExecutionFactsConfig,
  ) {
    this.graph = createAnswerGenerationGraph({
      ...dependencies,
      audit: lifecycleAudit(lifecycle),
    });
  }

  /** 执行一个已持有数据库租约的 Run，并确保正文只在最终校验后发布。 */
  public async execute(context: AccessContext, claimed: ClaimedRagRunExecution): Promise<RagRun> {
    const started = await this.lifecycle.start(
      claimed.ownerUserId,
      claimed.run.id,
      claimed.run.optimisticVersion,
    );
    try {
      const state = await this.graph.invoke({
        runId: started.run.id,
        context,
        signal: started.signal,
        deadlineAt: new Date(started.run.deadlineAt),
      });
      if (!state.finalAnswer || !state.bundle || !state.route || !state.validation) {
        throw new Error('ANSWER_GRAPH_INCOMPLETE');
      }
      const citationIds = new Set(state.finalAnswer.citations);
      const citations = state.bundle.sources.filter((source) => citationIds.has(source.sourceId));
      return await this.lifecycle.complete(
        claimed.ownerUserId,
        started.run.id,
        started.run.optimisticVersion,
        renderFinalAnswer(state.finalAnswer),
        {
          status: state.finalAnswer.status,
          sourceIds: state.finalAnswer.citations,
          spaceIds: [...new Set(citations.map((source) => source.spaceId))],
          degraded: state.degraded,
        },
        citations,
        {
          bundleSha256: state.bundle.bundleSha256,
          evidenceRoute: state.route,
          finalStatus: state.finalAnswer.status,
          validation: state.validation,
          ...(state.rerankerIdentity ? { reranker: state.rerankerIdentity } : {}),
          ...(state.draft
            ? {
                llm: {
                  modelId: this.factsConfig.llmModelId,
                  revision: started.run.snapshot.llmRevision,
                },
              }
            : {}),
          evaluation: buildEvaluationFacts(state),
        },
      );
    } catch {
      // 取消请求会先把 Run 推进到 CANCELLING 并增加一次版本；其余异常统一使用稳定失败码。
      if (started.signal.aborted) {
        return this.lifecycle.finalizeCancellation(
          claimed.ownerUserId,
          started.run.id,
          started.run.optimisticVersion + 1,
        );
      }
      return this.lifecycle.fail(
        claimed.ownerUserId,
        started.run.id,
        started.run.optimisticVersion,
        'ANSWER_GENERATION_FAILED',
      );
    }
  }
}

/**
 * OPS-002：把评分需要的候选与 Claim 事实写入受控评测表，而不是用户可见消息元数据。
 * supported 由 Validator/Judge 的稳定结果推导，不再次调用模型。
 */
function buildEvaluationFacts(state: {
  readonly candidates: readonly { readonly documentId: string; readonly chunkId: string }[];
  readonly draft?: {
    readonly claims: readonly { readonly claimId: string; readonly text: string }[];
  };
  readonly finalAnswer?: {
    readonly claims: readonly { readonly claimId: string; readonly text: string }[];
  };
  readonly validation?: {
    readonly issues: readonly {
      readonly claimId: string | null;
      readonly code: string;
      readonly severity: string;
    }[];
    readonly semanticJudge: { readonly unsupportedClaimIds: readonly string[] } | null;
  };
}): {
  readonly retrievedDocumentIds: readonly string[];
  readonly retrievedChunkIds: readonly string[];
  readonly claims: readonly { readonly text: string; readonly supported: boolean }[];
  readonly securityViolations: readonly string[];
} {
  const rejectedClaims = new Set(
    state.validation?.issues
      .filter((issue) => issue.claimId && issue.severity !== 'WARNING')
      .map((issue) => issue.claimId as string) ?? [],
  );
  for (const claimId of state.validation?.semanticJudge?.unsupportedClaimIds ?? []) {
    rejectedClaims.add(claimId);
  }
  const claims = state.draft?.claims ?? state.finalAnswer?.claims ?? [];
  return {
    retrievedDocumentIds: [...new Set(state.candidates.map((item) => item.documentId))],
    retrievedChunkIds: [...new Set(state.candidates.map((item) => item.chunkId))],
    claims: claims.map((claim) => ({
      text: claim.text,
      supported: !rejectedClaims.has(claim.claimId),
    })),
    securityViolations:
      state.validation?.issues
        .map((issue) => issue.code)
        .filter((code) => /^(PROMPT|SECURITY|INJECTION|UNTRUSTED)_/.test(code)) ?? [],
  };
}

function lifecycleAudit(lifecycle: RagRunLifecycleService): AnswerGenerationStageAudit {
  return {
    start: async (runId, nodeKey, attempt, input) => {
      await lifecycle.startStep(runId, { nodeKey, attempt, inputSummary: input });
    },
    finish: async (runId, nodeKey, attempt, status, output) => {
      await lifecycle.finishStep(runId, {
        nodeKey,
        attempt,
        status,
        outputSummary: output,
        ...(status === 'FAILED'
          ? { errorCode: 'ANSWER_STAGE_FAILED', errorMessage: '答案阶段执行失败' }
          : {}),
      });
    },
  };
}
