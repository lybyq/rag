/**
 * M06 Deadline 与敏感正文保留期维护服务。
 * 超时 Run 由 PG 条件更新进入 EXPIRED；正文到期只清理内容，不删除审计 Hash、Run 和反馈。
 *
 * @requirement RUN-005
 * @requirement RUN-014
 */
import type { RagRunRepository } from './rag-run.ports';

/** 一轮维护结果。 */
export interface RagRunMaintenanceResult {
  readonly expiredRuns: number;
  /** 本轮清理的消息正文与会话有限记忆总数。 */
  readonly redactedContents: number;
}

/** M06 周期维护应用服务。 */
export class RagRunMaintenanceService {
  public constructor(private readonly repository: RagRunRepository) {}

  /** 每次处理有限数量，避免清理任务长事务影响在线问答。 */
  public async runOnce(limit: number): Promise<RagRunMaintenanceResult> {
    return {
      expiredRuns: await this.repository.expireOverdueRuns(limit),
      redactedContents: await this.repository.cleanupExpiredContent(limit),
    };
  }
}
