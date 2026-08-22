/**
 * M03 文件安全与解析端口。
 * 应用层只依赖稳定契约，不知道内置扫描规则、Docling、PaddleOCR、MinIO 或 PostgreSQL SDK。
 *
 * @requirement PAR-002
 * @requirement PAR-004
 * @requirement PAR-005
 * @requirement PAR-012
 * @requirement PAR-013
 */
import type {
  DocumentBlock,
  DocumentParseRun,
  FileSecurityVerdict,
  ListDocumentBlocksQuery,
  MalwareScanResult,
  OcrTarget,
  OcrResult,
  ParseIssue,
  ParserResult,
  ProcessingFailureClass,
  ProcessingProviderProfile,
  ProviderProfile,
  SupportedFileFormat,
} from '@rag/contracts';
import type { DocumentBlockDraft, FileSecurityFinding } from '@rag/parser-core';
import type { AccessContext } from './ports';

/** Provider 调用只接收可重复签发的短时下载 URL，不接触永久凭证。 */
export interface ProviderDocumentSource {
  readonly url: string;
  readonly fileName: string;
  readonly format: SupportedFileFormat;
  readonly declaredMime: string;
}

/** 恶意软件扫描端口以流方式消费文件，避免把中型企业的大文件整体读入 Node 堆。 */
export interface MalwareScannerPort {
  scan(content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<MalwareScanResult>;
  profile(): ProcessingProviderProfile;
}

/** Parser 负责格式路由、结构提取与资源检查，输出必须通过 ParserResultSchema。 */
export interface ParserPort {
  parse(source: ProviderDocumentSource, signal: AbortSignal): Promise<ParserResult>;
  profile(): ProcessingProviderProfile;
}

/** OCR 只处理编排器明确选择的页、区域或内嵌图片，防止无差别重复识别。 */
export interface OcrPort {
  recognize(
    source: ProviderDocumentSource,
    targets: readonly OcrTarget[],
    signal: AbortSignal,
  ): Promise<OcrResult>;
  profile(): ProcessingProviderProfile;
}

/** Worker 从数据库读取的单一可信处理输入。 */
export interface DocumentProcessingInput {
  readonly jobId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly attempt: number;
  readonly fileId: string;
  readonly originalFileName: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly declaredMime: string;
  readonly uploadedSha256: string | null;
}

/** 创建或恢复解析运行所需的不可变 Provider 快照。 */
export interface BeginParseRunCommand {
  readonly input: DocumentProcessingInput;
  /** 当前部署画像，与 Parser/OCR revision 一起固定本次运行事实。 */
  readonly providerProfile: ProviderProfile;
  readonly parserProfileId: string;
  readonly parserRevision: string;
  readonly ocrProfileId: string;
  readonly ocrRevision: string;
}

/** 恶意软件扫描与可信字节事实先于 Parser 落库，命中时禁止继续解析。 */
export interface RecordPreflightCommand {
  readonly jobId: string;
  readonly workerId: string;
  readonly parseRunId: string;
  readonly fileId: string;
  readonly trustedSha256: string;
  readonly format: SupportedFileFormat;
  readonly detectedMime: string;
  readonly malware: MalwareScanResult;
}

/** 安全检查完成后写入的事实；发现项必须使用稳定代码而不是供应商原始响应。 */
export interface RecordSecurityCommand {
  readonly jobId: string;
  readonly workerId: string;
  readonly parseRunId: string;
  readonly fileId: string;
  readonly trustedSha256: string;
  readonly format: SupportedFileFormat;
  readonly detectedMime: string;
  readonly verdict: FileSecurityVerdict;
  readonly findings: readonly FileSecurityFinding[];
  readonly malware: MalwareScanResult;
}

/** M03 成功提交命令；Block、问题、快照定位和状态转换必须在一个事务中完成。 */
export interface CompleteDocumentProcessingCommand {
  readonly jobId: string;
  readonly workerId: string;
  readonly parseRunId: string;
  readonly parser: ParserResult;
  readonly ocr: OcrResult | null;
  readonly blocks: readonly DocumentBlockDraft[];
  readonly issues: readonly Omit<ParseIssue, 'id' | 'parseRunId' | 'createdAt'>[];
  readonly derivedBucket: string;
  readonly derivedObjectKey: string;
  readonly derivedSha256: string;
  readonly snapshotReused: boolean;
  readonly durationMs: number;
}

/** 可定位失败命令；公开消息不得携带文件正文、URL、密钥或供应商完整响应。 */
export interface FailDocumentProcessingCommand {
  readonly jobId: string;
  readonly workerId: string;
  readonly parseRunId: string | null;
  readonly failureClass: ProcessingFailureClass;
  readonly failureCode: string;
  readonly publicMessage: string;
  readonly retryable: boolean;
}

/** Block 游标页。 */
export interface DocumentBlockPage {
  readonly items: readonly DocumentBlock[];
  readonly nextOrdinal: number | null;
}

/** PostgreSQL M03 事实源端口。 */
export interface DocumentProcessingRepository {
  loadInput(jobId: string, workerId: string): Promise<DocumentProcessingInput | undefined>;
  beginRun(command: BeginParseRunCommand): Promise<DocumentParseRun>;
  recordPreflight(command: RecordPreflightCommand): Promise<void>;
  recordSecurity(command: RecordSecurityCommand): Promise<void>;
  startStep(
    jobId: string,
    workerId: string,
    step: 'PARSE' | 'OCR' | 'NORMALIZE',
    publicMessage: string,
  ): Promise<void>;
  complete(command: CompleteDocumentProcessingCommand): Promise<void>;
  waitForManualReview(
    jobId: string,
    workerId: string,
    parseRunId: string,
    publicMessage: string,
  ): Promise<void>;
  fail(command: FailDocumentProcessingCommand): Promise<void>;
  listRuns(context: AccessContext, documentVersionId: string): Promise<readonly DocumentParseRun[]>;
  getRun(
    context: AccessContext,
    parseRunId: string,
  ): Promise<{ run: DocumentParseRun; issues: readonly ParseIssue[] } | undefined>;
  listBlocks(
    context: AccessContext,
    parseRunId: string,
    query: ListDocumentBlocksQuery,
  ): Promise<DocumentBlockPage>;
}

/** M03 依赖注入 Token。 */
export const DOCUMENT_PROCESSING_REPOSITORY = Symbol('DOCUMENT_PROCESSING_REPOSITORY');
export const MALWARE_SCANNER = Symbol('MALWARE_SCANNER');
export const DOCUMENT_PARSER = Symbol('DOCUMENT_PARSER');
export const DOCUMENT_OCR = Symbol('DOCUMENT_OCR');
