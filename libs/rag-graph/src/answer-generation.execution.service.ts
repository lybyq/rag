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
