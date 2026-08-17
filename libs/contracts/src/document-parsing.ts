/**
 * M03 文件安全、解析、OCR 与统一 DocumentBlock 的运行时契约。
 * Provider、数据库 Adapter、Worker 和管理端都复用这些 Zod Schema，避免各层自行猜测字段。
 * 本文件只描述可序列化事实，不包含 SDK、网络调用或数据库实现。
 *
 * @requirement PAR-001
 * @requirement PAR-005
 * @requirement PAR-008
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 * @requirement PAR-015
 */
import { z } from 'zod';
import { createApiEnvelopeSchema } from './api-envelope';
import { Sha256Schema } from './document-ingestion';

/** M03 明确支持的输入格式；ZIP 容器必须进一步判定为某种 Office 格式。 */
export const SupportedFileFormatSchema = z.enum([
  'PDF',
  'DOCX',
  'XLSX',
  'PPTX',
  'IMAGE',
  'HTML',
  'MARKDOWN',
  'TEXT',
  'CSV',
]);
export type SupportedFileFormat = z.infer<typeof SupportedFileFormatSchema>;

/** 安全门禁只输出三种明确结论，绝不把扫描异常当作 CLEAN。 */
export const FileSecurityVerdictSchema = z.enum(['CLEAN', 'MANUAL_REVIEW', 'REJECTED']);
export type FileSecurityVerdict = z.infer<typeof FileSecurityVerdictSchema>;

/** 解析运行事实状态与入库任务解耦，便于保留每次 Parser 运行历史。 */
export const ParseRunStatusSchema = z.enum([
  'RUNNING',
  'SUCCEEDED',
  'WAITING',
  'FAILED',
  'REJECTED',
]);
export type ParseRunStatus = z.infer<typeof ParseRunStatusSchema>;

/** 故障分类决定是否重试，不能依赖供应商错误字符串做临时判断。 */
export const ProcessingFailureClassSchema = z.enum([
  'RETRYABLE_PROVIDER',
  'DOCUMENT_PROBLEM',
  'DEVELOPER_DEFECT',
]);
export type ProcessingFailureClass = z.infer<typeof ProcessingFailureClassSchema>;

/** 统一 Block 类型；M04 只能消费这些 Block，Parser 不能直接产出最终 Chunk。 */
export const DocumentBlockTypeSchema = z.enum([
  'TITLE',
  'PARAGRAPH',
  'LIST',
  'TABLE',
  'TABLE_ROW',
  'IMAGE',
  'CAPTION',
  'CODE',
  'FORMULA',
  'HEADER',
  'FOOTER',
  'FOOTNOTE',
]);
export type DocumentBlockType = z.infer<typeof DocumentBlockTypeSchema>;

/** ISO 时间必须带时区，保证 Worker、API 和内网 Provider 的耗时事实可比较。 */
const TimestampSchema = z.iso.datetime({ offset: true });

/** 页面坐标统一归一化到 0～1；原点固定为左上角。 */
export const NormalizedBoundingBoxSchema = z
  .object({
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
    x2: z.number().min(0).max(1),
    y2: z.number().min(0).max(1),
  })
  .refine((box) => box.x1 <= box.x2 && box.y1 <= box.y2, {
    message: 'bbox 左上角不能位于右下角之后',
  });
export type NormalizedBoundingBox = z.infer<typeof NormalizedBoundingBoxSchema>;

/** 合并单元格使用零起始行列号，rowSpan/colSpan 至少为 1。 */
export const MergedTableCellSchema = z.object({
  row: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive(),
  columnSpan: z.number().int().positive(),
});

/** 表格结构同时保留二维内容、表头行数和合并信息。 */
export const DocumentTableSchema = z.object({
  rows: z.array(z.array(z.string())).min(1),
  headerRowCount: z.number().int().nonnegative(),
  mergedCells: z.array(MergedTableCellSchema),
});
export type DocumentTable = z.infer<typeof DocumentTableSchema>;

/** Parser/OCR 的标准化候选 Block；数据库 ID 和稳定 ordinal 由领域层生成。 */
export const ParsedBlockCandidateSchema = z.object({
  type: DocumentBlockTypeSchema,
  text: z.string(),
  originalText: z.string(),
  pageNo: z.number().int().positive().nullable(),
  sheetName: z.string().min(1).max(200).nullable(),
  slideNo: z.number().int().positive().nullable(),
  bbox: NormalizedBoundingBoxSchema.nullable(),
  headingLevel: z.number().int().min(1).max(6).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  table: DocumentTableSchema.nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type ParsedBlockCandidate = z.infer<typeof ParsedBlockCandidateSchema>;

/** 持久化后的统一 Block；originalText 永不被标准化结果覆盖。 */
export const DocumentBlockSchema = ParsedBlockCandidateSchema.extend({
  id: z.string().min(1).max(160),
  parseRunId: z.uuid(),
  documentVersionId: z.uuid(),
  contentRevision: z.number().int().positive(),
  ordinal: z.number().int().positive(),
  parentBlockId: z.string().min(1).max(160).nullable(),
  parserName: z.string().min(1).max(100),
  parserRevision: z.string().min(1).max(100),
  ocrEngine: z.string().min(1).max(100).nullable(),
  ocrRevision: z.string().min(1).max(100).nullable(),
  contentSha256: Sha256Schema,
  createdAt: TimestampSchema,
});
export type DocumentBlock = z.infer<typeof DocumentBlockSchema>;

/** 安全或质量问题可以定位到页和 Block，管理端只显示脱敏消息。 */
export const ParseIssueSchema = z.object({
  id: z.uuid(),
  parseRunId: z.uuid(),
  severity: z.enum(['INFO', 'WARNING', 'ERROR']),
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(500),
  pageNo: z.number().int().positive().nullable(),
  blockId: z.string().min(1).max(160).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: TimestampSchema,
});
export type ParseIssue = z.infer<typeof ParseIssueSchema>;

/** 文件结构检查事实；数值为 null 表示该格式不适用，而不是扫描成功的 0。 */
export const FileStructureInspectionSchema = z.object({
  encrypted: z.boolean(),
  hasMacros: z.boolean(),
  embeddedObjectCount: z.number().int().nonnegative(),
  externalLinkCount: z.number().int().nonnegative(),
  archiveDepth: z.number().int().nonnegative().nullable(),
  compressedSizeBytes: z.number().int().nonnegative().nullable(),
  uncompressedSizeBytes: z.number().int().nonnegative().nullable(),
  pageCount: z.number().int().positive().nullable(),
  totalPixels: z.number().int().nonnegative().nullable(),
  tableCellCount: z.number().int().nonnegative().nullable(),
});
export type FileStructureInspection = z.infer<typeof FileStructureInspectionSchema>;

/** 恶意软件扫描器输出稳定结果和签名库版本，异常必须抛出而不能伪装 CLEAN。 */
export const MalwareScanResultSchema = z.object({
  verdict: z.enum(['CLEAN', 'INFECTED']),
  engine: z.string().min(1).max(100),
  engineRevision: z.string().min(1).max(100),
  signatureName: z.string().min(1).max(300).nullable(),
  scannedBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type MalwareScanResult = z.infer<typeof MalwareScanResultSchema>;

/** 单页文本覆盖率用于决定是否触发 OCR，不能用整本文件的平均值掩盖扫描页。 */
export const ParsedPageSchema = z.object({
  pageNo: z.number().int().positive(),
  textCharacterCount: z.number().int().nonnegative(),
  textCoverage: z.number().min(0).max(1),
  imageOnly: z.boolean(),
});
export type ParsedPage = z.infer<typeof ParsedPageSchema>;

/** Parser Port 的内部标准结果，任何供应商响应都必须先映射并校验成此结构。 */
export const ParserResultSchema = z.object({
  parserName: z.string().min(1).max(100),
  parserRevision: z.string().min(1).max(100),
  protocolVersion: z.string().min(1).max(40),
  blocks: z.array(ParsedBlockCandidateSchema),
  pages: z.array(ParsedPageSchema),
  inspection: FileStructureInspectionSchema,
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(500)),
});
export type ParserResult = z.infer<typeof ParserResultSchema>;

/** OCR 只返回调用方指定页面的 Block，并携带页级平均置信度和引擎版本。 */
export const OcrPageResultSchema = z.object({
  pageNo: z.number().int().positive(),
  blocks: z.array(ParsedBlockCandidateSchema),
  averageConfidence: z.number().min(0).max(1),
});

/** OCR Port 的稳定返回契约。 */
export const OcrResultSchema = z.object({
  engine: z.string().min(1).max(100),
  engineRevision: z.string().min(1).max(100),
  protocolVersion: z.string().min(1).max(40),
  pages: z.array(OcrPageResultSchema),
  durationMs: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(500)),
});
export type OcrResult = z.infer<typeof OcrResultSchema>;

/** M03 解析运行详情；失败只保存分类和公开错误，不保存预签名 URL 或正文。 */
export const DocumentParseRunSchema = z.object({
  id: z.uuid(),
  jobId: z.string().min(1).max(300),
  documentVersionId: z.uuid(),
  contentRevision: z.number().int().positive(),
  status: ParseRunStatusSchema,
  fileFormat: SupportedFileFormatSchema.nullable(),
  declaredMime: z.string().max(160).nullable(),
  detectedMime: z.string().max(160).nullable(),
  inputSha256: Sha256Schema.nullable(),
  securityVerdict: FileSecurityVerdictSchema.nullable(),
  malwareEngine: z.string().max(100).nullable(),
  malwareRevision: z.string().max(100).nullable(),
  parserProfileId: z.string().min(1).max(100),
  parserRevision: z.string().min(1).max(100),
  ocrProfileId: z.string().min(1).max(100),
  ocrRevision: z.string().min(1).max(100),
  pageCount: z.number().int().nonnegative(),
  blockCount: z.number().int().nonnegative(),
  ocrPageCount: z.number().int().nonnegative(),
  derivedBucket: z.string().max(63).nullable(),
  derivedObjectKey: z.string().max(1024).nullable(),
  derivedSha256: Sha256Schema.nullable(),
  failureClass: ProcessingFailureClassSchema.nullable(),
  failureCode: z.string().max(100).nullable(),
  failureMessage: z.string().max(500).nullable(),
  metrics: z.record(z.string(), z.unknown()),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type DocumentParseRun = z.infer<typeof DocumentParseRunSchema>;

/** 管理端展示的有效 Provider Profile，不暴露 API Key。 */
export const ProcessingProviderProfileSchema = z.object({
  kind: z.enum(['MALWARE_SCANNER', 'PARSER', 'OCR']),
  adapter: z.string().min(1).max(60),
  profileId: z.string().min(1).max(100),
  revision: z.string().min(1).max(100),
  protocolVersion: z.string().min(1).max(40),
  endpoint: z.string().max(300).nullable(),
  capabilities: z.array(z.string().min(1).max(100)),
  timeoutMs: z.number().int().positive(),
});
export type ProcessingProviderProfile = z.infer<typeof ProcessingProviderProfileSchema>;

/** Block 游标使用稳定 ordinal；同一 parse run 内不会因新写入而漂移。 */
export const ListDocumentBlocksQuerySchema = z.object({
  afterOrdinal: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListDocumentBlocksQuery = z.infer<typeof ListDocumentBlocksQuerySchema>;

/** Parse Run 详情同时返回问题列表，Block 单独分页避免大文档响应过大。 */
export const ParseRunDetailEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ run: DocumentParseRunSchema, issues: z.array(ParseIssueSchema) }),
);

/** 一个内容修订可以保留多次运行记录。 */
export const ParseRunListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(DocumentParseRunSchema) }),
);

/** Block 页面返回下一个 ordinal；null 表示已经读取完毕。 */
export const DocumentBlockListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({
    items: z.array(DocumentBlockSchema),
    nextOrdinal: z.number().int().positive().nullable(),
  }),
);

/** Provider Profile 列表供管理员排查当前生效版本。 */
export const ProcessingProviderProfileListEnvelopeSchema = createApiEnvelopeSchema(
  z.object({ items: z.array(ProcessingProviderProfileSchema) }),
);
