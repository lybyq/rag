/**
 * 文件解析与OCR 文件安全、Parser、按页 OCR、Block 规范化和派生快照编排。
 * 每一步都由端口隔离，失败分类和状态提交集中在这里，避免 Adapter 各自决定业务结果。
 *
 * @requirement PAR-001
 * @requirement PAR-002
 * @requirement PAR-003
 * @requirement PAR-004
 * @requirement PAR-005
 * @requirement PAR-006
 * @requirement PAR-007
 * @requirement PAR-008
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 * @requirement PAR-012
 * @requirement PAR-013
 * @requirement PAR-016
 * @requirement PAR-024
 */
import type {
  OcrTarget,
  ParseIssue,
  ProcessingFailureClass,
  ProviderProfile,
} from '@rag/contracts';
import {
  assessOcrTargetResults,
  buildDerivedSnapshotKey,
  buildDocumentBlocks,
  detectFileFormat,
  evaluateFileSecurity,
  FileRejectedError,
  mergeOcrBlocks,
  selectSupportedOcrTargets,
  selectOcrTargets,
  sha256Text,
  type FileSecurityLimits,
  type OcrTargetAssessment,
} from '@rag/parser-core';
import { createHash } from 'node:crypto';
import type {
  DocumentProcessingRepository,
  MalwareScannerPort,
  OcrPort,
  ParserPort,
} from './document-processing.ports';
import type { ObjectStoragePort } from './ingestion.ports';

/** 文件解析与OCR 对外部调用和安全阈值的部署配置。 */
export interface DocumentProcessingConfig extends FileSecurityLimits {
  /** 本进程启动时已通过白名单加载并校验的 Provider Profile。 */
  readonly providerProfile: ProviderProfile;
  readonly derivedBucket: string;
  readonly presignedGetTtlSeconds: number;
  readonly storageTimeoutMs: number;
  readonly objectStreamTimeoutMs: number;
  readonly ocrTextCoverageThreshold: number;
  readonly ocrMinConfidence: number;
  readonly maxAttempts: number;
}

/** Worker 用于决定是否让 BullMQ 重试的稳定结果。 */
export type DocumentProcessingOutcome = 'COMPLETED' | 'MANUAL_REVIEW' | 'REJECTED' | 'FAILED';

/** 文件解析与OCR 应用编排器；单次调用只处理已经由当前 Worker 持有 lease 的一个 Job。 */
export class DocumentProcessingService {
  public constructor(
    private readonly repository: DocumentProcessingRepository,
    private readonly storage: ObjectStoragePort,
    private readonly scanner: MalwareScannerPort,
    private readonly parser: ParserPort,
    private readonly ocr: OcrPort,
    private readonly config: DocumentProcessingConfig,
  ) {}

  public async process(jobId: string, workerId: string): Promise<DocumentProcessingOutcome> {
    const startedAt = Date.now();
    const input = await this.repository.loadInput(jobId, workerId);
    if (!input) return 'FAILED';
    const parserProfile = this.parser.profile();
    const ocrProfile = this.ocr.profile();
    const run = await this.repository.beginRun({
      input,
      providerProfile: this.config.providerProfile,
      parserProfileId: parserProfile.profileId,
      parserRevision: parserProfile.revision,
      ocrProfileId: ocrProfile.profileId,
      ocrRevision: ocrProfile.revision,
    });

    try {
      const stream = await this.storage.readObject(input.bucket, input.objectKey, {
        signal: AbortSignal.timeout(this.config.objectStreamTimeoutMs),
      });
      const observation = observeContent(stream, 8 * 1024);
      const malware = await this.scanner.scan(observation.content, this.providerSignal());
      const observed = observation.result();
      if (observed.sizeBytes !== input.sizeBytes || malware.scannedBytes !== input.sizeBytes) {
        throw new FileRejectedError('OBJECT_SIZE_CHANGED', '隔离区对象大小与上传完成事实不一致');
      }
      if (input.uploadedSha256 && observed.sha256 !== input.uploadedSha256) {
        throw new FileRejectedError('OBJECT_HASH_CHANGED', '隔离区对象哈希与上传完成事实不一致');
      }
      const detected = detectFileFormat(
        observed.header,
        input.originalFileName,
        input.declaredMime,
      );
      await this.repository.recordPreflight({
        jobId,
        workerId,
        parseRunId: run.id,
        fileId: input.fileId,
        trustedSha256: observed.sha256,
        format: detected.format,
        detectedMime: detected.detectedMime,
        malware,
      });
      if (malware.verdict === 'INFECTED') {
        await this.repository.fail({
          jobId,
          workerId,
          parseRunId: run.id,
          failureClass: 'DOCUMENT_PROBLEM',
          failureCode: 'MALWARE_DETECTED',
          publicMessage: '恶意软件扫描命中，文件已拒绝进入解析器',
          retryable: false,
        });
        return 'REJECTED';
      }

      await this.repository.startStep(jobId, workerId, 'PARSE', '正在隔离 Parser 中检查并解析结构');
      const source = {
        url: await this.storage.presignGet(
          input.bucket,
          input.objectKey,
          this.config.presignedGetTtlSeconds,
          this.storageCallOptions(),
        ),
        fileName: input.originalFileName,
        format: detected.format,
        declaredMime: input.declaredMime,
      };
      const parsed = await this.parser.parse(source, this.providerSignal());
      const security = evaluateFileSecurity(parsed.inspection, malware, this.config);
      await this.repository.recordSecurity({
        jobId,
        workerId,
        parseRunId: run.id,
        fileId: input.fileId,
        trustedSha256: observed.sha256,
        format: detected.format,
        detectedMime: detected.detectedMime,
        verdict: security.verdict,
        findings: security.findings,
        malware,
      });
      if (security.verdict === 'REJECTED') {
        await this.repository.fail({
          jobId,
          workerId,
          parseRunId: run.id,
          failureClass: 'DOCUMENT_PROBLEM',
          failureCode: security.findings[0]?.code ?? 'SECURITY_REJECTED',
          publicMessage: '文件未通过安全门禁，已拒绝进入知识库',
          retryable: false,
        });
        return 'REJECTED';
      }
      if (security.verdict === 'MANUAL_REVIEW') {
        await this.repository.waitForManualReview(
          jobId,
          workerId,
          run.id,
          '文件包含嵌入对象或外部链接，等待管理员复核',
        );
        return 'MANUAL_REVIEW';
      }

      const proposedOcrTargets = selectOcrTargets(
        parsed.pages,
        parsed.ocrCandidates,
        this.config.ocrTextCoverageThreshold,
        detected.format,
      );
      const capabilitySelection = selectSupportedOcrTargets(
        proposedOcrTargets,
        ocrProfile.capabilities,
      );
      const ocrTargets = capabilitySelection.supported;
      let ocrResult = null;
      if (ocrTargets.length > 0) {
        await this.repository.startStep(jobId, workerId, 'OCR', '仅识别低覆盖页面或图片目标');
        ocrResult = await this.ocr.recognize(source, ocrTargets, this.providerSignal());
      }
      await this.repository.startStep(jobId, workerId, 'NORMALIZE', '正在生成统一 DocumentBlock');
      const assessments = assessOcrTargetResults(
        ocrTargets,
        ocrResult?.results ?? [],
        this.config.ocrMinConfidence,
      );
      const candidates = mergeOcrBlocks(parsed.blocks, assessments);
      const blocks = buildDocumentBlocks({
        parseRunId: run.id,
        documentVersionId: input.documentVersionId,
        contentRevision: input.contentRevision,
        parserName: parsed.parserName,
        parserRevision: parsed.parserRevision,
        ...(ocrResult
          ? { ocrEngine: ocrResult.engine, ocrRevision: ocrResult.engineRevision }
          : {}),
        candidates,
      });
      const issues = buildIssues(
        detected.warnings,
        parsed.warnings,
        (ocrResult?.warnings ?? []).filter((warning) => warning !== 'OCR_TARGET_RESULT_MISSING'),
        assessments,
        capabilitySelection.unsupported,
        this.config.ocrMinConfidence,
      );
      const requiresManualReview =
        assessments.some(requiresBlockingReview) ||
        capabilitySelection.unsupported.some(isRequiredTextTarget);
      const ocrOutcomeCounts = countOcrOutcomes(assessments, capabilitySelection.unsupported);
      const snapshot = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 'document-blocks/v1',
          documentVersionId: input.documentVersionId,
          contentRevision: input.contentRevision,
          inputSha256: observed.sha256,
          parserProfile,
          ocrProfile,
          blocks,
          issues,
        }),
      );
      const snapshotSha256 = sha256Text(new TextDecoder().decode(snapshot));
      const objectKey = buildDerivedSnapshotKey(
        input.documentVersionId,
        input.contentRevision,
        parserProfile.profileId,
        parserProfile.revision,
      );
      await this.storage.ensureNamedBucket(this.config.derivedBucket, this.storageCallOptions());
      const snapshotReused = await this.hasMatchingSnapshot(objectKey, snapshotSha256);
      if (!snapshotReused) {
        await this.storage.putObject(
          this.config.derivedBucket,
          objectKey,
          { bytes: snapshot, contentType: 'application/json', sha256: snapshotSha256 },
          this.storageCallOptions(),
        );
      }
      await this.repository.complete({
        jobId,
        workerId,
        parseRunId: run.id,
        parser: parsed,
        ocr: ocrResult,
        blocks,
        issues,
        derivedBucket: this.config.derivedBucket,
        derivedObjectKey: objectKey,
        derivedSha256: snapshotSha256,
        snapshotReused,
        durationMs: Date.now() - startedAt,
        ocrOutcomeCounts,
        requiresManualReview,
        reviewReason: requiresManualReview
          ? '关键页面 OCR 结果不可用，已保留原生内容并等待人工审核'
          : null,
      });
      return requiresManualReview ? 'MANUAL_REVIEW' : 'COMPLETED';
    } catch (error) {
      const classified = classifyProcessingFailure(error);
      const failure =
        classified.retryable && input.attempt >= this.config.maxAttempts
          ? {
              ...classified,
              publicMessage: '外部处理服务连续失败已达上限，等待管理员处理',
              retryable: false,
            }
          : classified;
      await this.repository.fail({
        jobId,
        workerId,
        parseRunId: run.id,
        ...failure,
      });
      if (failure.retryable) throw error;
      return 'FAILED';
    }
  }

  /** 只吞掉明确的对象不存在；权限或网络异常必须继续失败，不能覆盖未知旧快照。 */
  private async hasMatchingSnapshot(objectKey: string, sha256: string): Promise<boolean> {
    try {
      const head = await this.storage.headObject(
        this.config.derivedBucket,
        objectKey,
        this.storageCallOptions(),
      );
      return head.sha256 === sha256;
    } catch (error) {
      if (isObjectNotFound(error)) return false;
      throw error;
    }
  }

  private storageCallOptions(): { signal: AbortSignal } {
    return { signal: AbortSignal.timeout(this.config.storageTimeoutMs) };
  }

  private providerSignal(): AbortSignal {
    // Adapter 还有各自更细的 timeout；这里提供统一的最终取消上限。
    return AbortSignal.timeout(Math.max(this.config.storageTimeoutMs * 20, 60_000));
  }
}

/** 一次遍历同时计算可信哈希、大小和格式识别所需头部。 */
function observeContent(
  input: AsyncIterable<Uint8Array>,
  headerLimit: number,
): {
  content: AsyncIterable<Uint8Array>;
  result: () => { header: Uint8Array; sha256: string; sizeBytes: number };
} {
  const hash = createHash('sha256');
  const headerChunks: Uint8Array[] = [];
  let headerBytes = 0;
  let sizeBytes = 0;
  let completed = false;
  const content = (async function* (): AsyncGenerator<Uint8Array> {
    for await (const chunk of input) {
      hash.update(chunk);
      sizeBytes += chunk.byteLength;
      if (headerBytes < headerLimit) {
        const selected = chunk.subarray(0, headerLimit - headerBytes);
        headerChunks.push(selected);
        headerBytes += selected.byteLength;
      }
      yield chunk;
    }
    completed = true;
  })();
  return {
    content,
    result: () => {
      if (!completed) throw new Error('Scanner 未完整消费输入流');
      const header = new Uint8Array(headerBytes);
      let offset = 0;
      for (const chunk of headerChunks) {
        header.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { header, sha256: hash.digest('hex'), sizeBytes };
    },
  };
}

function buildIssues(
  detectionWarnings: readonly string[],
  parserWarnings: readonly string[],
  ocrWarnings: readonly string[],
  assessments: readonly OcrTargetAssessment[],
  unsupportedTargets: readonly OcrTarget[],
  minimumConfidence: number,
): readonly Omit<ParseIssue, 'id' | 'parseRunId' | 'createdAt'>[] {
  const warnings = [...detectionWarnings, ...parserWarnings, ...ocrWarnings];
  const issues: Omit<ParseIssue, 'id' | 'parseRunId' | 'createdAt'>[] = warnings.map((warning) => ({
    severity: 'WARNING',
    code: warning.slice(0, 100),
    message: publicWarningMessage(warning),
    pageNo: null,
    blockId: null,
    metadata: {},
  }));
  for (const assessment of assessments) {
    if (assessment.status === 'SUCCESS') continue;
    const codeByStatus: Readonly<
      Record<Exclude<OcrTargetAssessment['status'], 'SUCCESS'>, string>
    > = {
      MISSING: 'OCR_RESULT_MISSING',
      EMPTY: 'OCR_EMPTY_RESULT',
      LOW_CONFIDENCE: 'OCR_LOW_CONFIDENCE',
      INVALID_LOCATION: 'OCR_TARGET_LOCATION_MISMATCH',
      DUPLICATE_RESULT: 'OCR_DUPLICATE_TARGET_RESULT',
    };
    issues.push({
      severity: isRequiredTextTarget(assessment.target) ? 'ERROR' : 'WARNING',
      code: codeByStatus[assessment.status],
      message: publicOcrAssessmentMessage(assessment.status),
      pageNo: assessment.target.pageNo,
      blockId: null,
      metadata: {
        targetId: assessment.target.targetId,
        targetKind: assessment.target.kind,
        ...(assessment.result
          ? { averageConfidence: assessment.result.averageConfidence, minimumConfidence }
          : {}),
      },
    });
  }
  for (const target of unsupportedTargets) {
    issues.push({
      severity: isRequiredTextTarget(target) ? 'ERROR' : 'WARNING',
      code: 'OCR_TARGET_UNSUPPORTED',
      message: '当前 OCR Provider 未声明支持该目标类型，未发送识别请求',
      pageNo: target.pageNo,
      blockId: null,
      metadata: { targetId: target.targetId, targetKind: target.kind },
    });
  }
  return issues;
}

/** PAGE/WHOLE_IMAGE 承载主要正文；不可用时必须停住发布，局部图片失败只形成补充告警。 */
function isRequiredTextTarget(target: OcrTarget): boolean {
  return target.kind === 'PAGE' || target.kind === 'WHOLE_IMAGE';
}

/** 判断逐目标失败是否需要把任务停在人工审核。 */
function requiresBlockingReview(assessment: OcrTargetAssessment): boolean {
  return assessment.status !== 'SUCCESS' && isRequiredTextTarget(assessment.target);
}

/** 把 OCR 目标状态汇总为低基数计数，不能把 targetId 写进指标名。 */
function countOcrOutcomes(
  assessments: readonly OcrTargetAssessment[],
  unsupportedTargets: readonly OcrTarget[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const assessment of assessments) {
    counts[assessment.status] = (counts[assessment.status] ?? 0) + 1;
  }
  if (unsupportedTargets.length > 0) counts.UNSUPPORTED = unsupportedTargets.length;
  return counts;
}

/** 将内部 OCR 状态映射为可公开、无正文和无供应商原始响应的提示。 */
function publicOcrAssessmentMessage(status: OcrTargetAssessment['status']): string {
  const messages: Readonly<Record<OcrTargetAssessment['status'], string>> = {
    SUCCESS: 'OCR 目标识别成功',
    MISSING: 'OCR 未返回该目标的结果，已保留原生内容',
    EMPTY: 'OCR 返回空内容，已保留原生内容',
    LOW_CONFIDENCE: 'OCR 平均置信度低于配置阈值，已保留原生内容',
    INVALID_LOCATION: 'OCR 结果定位与请求目标不一致，已保留原生内容',
    DUPLICATE_RESULT: 'OCR 对同一目标返回重复结果，已保留原生内容',
  };
  return messages[status];
}

function publicWarningMessage(code: string): string {
  const messages: Record<string, string> = {
    DECLARED_MIME_GENERIC: '上传方未提供明确 MIME，平台已使用文件内容识别',
    STRUCTURE_INSPECTION_LIMITED_DOCLING:
      '当前外网 Docling 结构安全能力有限，内网上线应切换企业 Parser 契约',
    DOCLING_DOES_NOT_EXPOSE_WORD_CONFIDENCE: '当前 Docling OCR 未提供词级置信度',
    FIXTURE_PARSER_NOT_FOR_PRODUCTION: '当前使用开发 Fixture Parser，结果仅用于流程演练',
    FIXTURE_OCR_NOT_FOR_PRODUCTION: '当前使用开发 Fixture OCR，结果仅用于流程演练',
    TEXT_MIXED_NEWLINE_STYLES: '纯文本同时包含多种换行格式，已保留原始换行并统一检索文本',
    CSV_DELIMITER_AMBIGUOUS: 'CSV 分隔符判断存在歧义，已保留方言判定事实等待复核',
    CSV_IRREGULAR_COLUMN_COUNT: 'CSV 各记录列数不一致，已保存源列宽并补齐矩形表格',
    CSV_HEADER_NOT_CONFIDENT: 'CSV 表头证据不足，首行按普通数据保留',
    CSV_MIXED_NEWLINE_STYLES: 'CSV 同时包含多种记录换行格式，已由标准状态机解析',
    IMAGE_ORIENTATION_INSPECTION_INCOMPLETE: '图片方向元数据存在但未能完整检查',
    IMAGE_ORIENTATION_NOT_APPLIED: '图片包含旋转方向信息，Parser 未改写原始像素',
  };
  return messages[code] ?? 'Provider 返回了可审计警告';
}

function classifyProcessingFailure(error: unknown): {
  failureClass: ProcessingFailureClass;
  failureCode: string;
  publicMessage: string;
  retryable: boolean;
} {
  if (error instanceof FileRejectedError) {
    return {
      failureClass: 'DOCUMENT_PROBLEM',
      failureCode: error.code,
      publicMessage: error.message,
      retryable: false,
    };
  }
  if (isProviderError(error)) {
    return {
      failureClass: error.failureClass,
      failureCode: error.code,
      publicMessage:
        error.failureClass === 'RETRYABLE_PROVIDER'
          ? '外部处理服务暂时不可用，任务将自动重试'
          : error.message,
      retryable: error.failureClass === 'RETRYABLE_PROVIDER',
    };
  }
  return {
    failureClass: 'DEVELOPER_DEFECT',
    failureCode: 'UNEXPECTED_PROCESSING_ERROR',
    publicMessage: '处理流程发生未分类错误，等待工程人员排查',
    retryable: false,
  };
}

function isProviderError(
  error: unknown,
): error is Error & { failureClass: ProcessingFailureClass; code: string } {
  return (
    error instanceof Error &&
    'failureClass' in error &&
    'code' in error &&
    ['RETRYABLE_PROVIDER', 'DOCUMENT_PROBLEM', 'DEVELOPER_DEFECT'].includes(
      String(error.failureClass),
    )
  );
}

function isObjectNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String(error.code) : '';
  return ['NoSuchKey', 'NotFound', 'NoSuchObject'].includes(code);
}
