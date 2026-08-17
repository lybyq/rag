/**
 * M03 管理查询用例。
 * Repository 负责按知识空间 ACL 收窄 Parse Run/Block，Provider Profile 额外限制为系统管理员或审计员。
 *
 * @requirement PAR-015
 */
import type {
  DocumentBlockPage,
  DocumentProcessingRepository,
  MalwareScannerPort,
  OcrPort,
  ParserPort,
} from './document-processing.ports';
import type {
  DocumentParseRun,
  ListDocumentBlocksQuery,
  ParseIssue,
  ProcessingProviderProfile,
} from '@rag/contracts';
import { ApplicationError } from './application.error';
import type { AccessContext } from './ports';

export class DocumentProcessingAdminService {
  public constructor(
    private readonly repository: DocumentProcessingRepository,
    private readonly scanner: MalwareScannerPort,
    private readonly parser: ParserPort,
    private readonly ocr: OcrPort,
  ) {}

  public listRuns(
    context: AccessContext,
    documentVersionId: string,
  ): Promise<readonly DocumentParseRun[]> {
    return this.repository.listRuns(context, documentVersionId);
  }

  public async getRun(
    context: AccessContext,
    parseRunId: string,
  ): Promise<{ run: DocumentParseRun; issues: readonly ParseIssue[] }> {
    const detail = await this.repository.getRun(context, parseRunId);
    if (!detail) throw new ApplicationError('NOT_FOUND', 404, '解析运行不存在');
    return detail;
  }

  public listBlocks(
    context: AccessContext,
    parseRunId: string,
    query: ListDocumentBlocksQuery,
  ): Promise<DocumentBlockPage> {
    return this.repository.listBlocks(context, parseRunId, query);
  }

  /** Profile 不暴露密钥；Endpoint 仍属于运维拓扑信息，只允许管理员和审计员读取。 */
  public listProfiles(context: AccessContext): readonly ProcessingProviderProfile[] {
    if (!context.user.roles.some((role) => role === 'SYSTEM_ADMIN' || role === 'AUDITOR')) {
      throw new ApplicationError(
        'ACCESS_DENIED',
        403,
        '仅系统管理员或审计员可查看 Provider Profile',
      );
    }
    return [this.scanner.profile(), this.parser.profile(), this.ocr.profile()];
  }
}
