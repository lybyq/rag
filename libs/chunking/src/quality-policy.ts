/**
 * M04 自动质量门禁纯函数。
 * 它把解析覆盖、OCR、结构、乱码、重复、缺页、表格、负责人和 revision 事实归并为三态结论。
 * 本文件不执行人工审核，也不直接改变任务或索引状态。
 *
 * @requirement KNO-009
 * @requirement KNO-010
 * @requirement KNO-013
 */
import type { DocumentBlock, DocumentQualityMetrics } from '@rag/contracts';
import type {
  QualityEvaluationInput,
  QualityEvaluationResult,
  QualityFindingDraft,
  QualityPolicyConfig,
} from './types';

/** 计算质量指标、稳定发现代码和最终三态裁决。 */
export function evaluateDocumentQuality(
  input: QualityEvaluationInput,
  config: QualityPolicyConfig,
): QualityEvaluationResult {
  const metrics = calculateMetrics(input);
  const findings: QualityFindingDraft[] = [];

  if (!metrics.hasResponsibleOwner) {
    findings.push(finding('ERROR', 'QUALITY_OWNER_MISSING', '知识空间缺少有效负责人'));
  }
  if (!metrics.versionConsistent) {
    findings.push(finding('ERROR', 'QUALITY_VERSION_CONFLICT', '解析结果与当前内容修订不一致'));
  }
  if (metrics.nonEmptyBlockRatio < config.rejectNonEmptyBlockRatio) {
    findings.push(
      finding('ERROR', 'QUALITY_PARSE_COVERAGE_CRITICAL', '可用文本覆盖率低于拒绝阈值', {
        actual: metrics.nonEmptyBlockRatio,
        threshold: config.rejectNonEmptyBlockRatio,
      }),
    );
  } else if (metrics.nonEmptyBlockRatio < config.minimumNonEmptyBlockRatio) {
    findings.push(
      finding('WARNING', 'QUALITY_PARSE_COVERAGE_LOW', '可用文本覆盖率偏低，需要人工确认', {
        actual: metrics.nonEmptyBlockRatio,
        threshold: config.minimumNonEmptyBlockRatio,
      }),
    );
  }
  if (metrics.garbledCharacterRatio >= config.rejectGarbledRatio) {
    findings.push(finding('ERROR', 'QUALITY_GARBLED_CRITICAL', '正文乱码比例超过拒绝阈值'));
  } else if (metrics.garbledCharacterRatio > config.maximumGarbledRatio) {
    findings.push(finding('WARNING', 'QUALITY_GARBLED_HIGH', '正文乱码比例偏高'));
  }
  if (
    metrics.averageOcrConfidence !== null &&
    metrics.averageOcrConfidence < config.minimumOcrConfidence
  ) {
    findings.push(
      finding('WARNING', 'QUALITY_OCR_CONFIDENCE_LOW', 'OCR 平均置信度低于质量阈值', {
        actual: metrics.averageOcrConfidence,
        threshold: config.minimumOcrConfidence,
      }),
    );
  }
  if (metrics.missingPageNos.length > 0) {
    findings.push({
      ...finding('WARNING', 'QUALITY_MISSING_PAGES', '解析结果存在缺失页'),
      pageNos: metrics.missingPageNos,
    });
  }
  if (metrics.malformedTableCount > 0) {
    findings.push(
      finding('WARNING', 'QUALITY_TABLE_MALFORMED', '部分表格行列或表头结构不完整', {
        count: metrics.malformedTableCount,
      }),
    );
  }
  if (metrics.duplicateChildRatio > config.maximumDuplicateRatio) {
    findings.push(
      finding('WARNING', 'QUALITY_DUPLICATE_RATIO_HIGH', '重复 Chunk 比例超过质量阈值', {
        actual: metrics.duplicateChildRatio,
        threshold: config.maximumDuplicateRatio,
      }),
    );
  }
  if (input.blocks.length >= config.requireHeadingAfterBlocks && metrics.headingCount === 0) {
    findings.push(finding('WARNING', 'QUALITY_STRUCTURE_WEAK', '长文档未恢复出标题结构'));
  }

  const hardRejectCodes = new Set([
    'QUALITY_OWNER_MISSING',
    'QUALITY_VERSION_CONFLICT',
    'QUALITY_PARSE_COVERAGE_CRITICAL',
    'QUALITY_GARBLED_CRITICAL',
  ]);
  const verdict = findings.some((item) => hardRejectCodes.has(item.code))
    ? 'REJECT'
    : findings.length > 0
      ? 'MANUAL_REVIEW'
      : 'PASS';
  return { verdict, metrics, findings };
}

function calculateMetrics(input: QualityEvaluationInput): DocumentQualityMetrics {
  const nonEmptyBlocks = input.blocks.filter((block) => block.text.trim().length > 0);
  const observedPages = new Set(
    input.blocks.flatMap((block) => (block.pageNo === null ? [] : [block.pageNo])),
  );
  const missingPageNos = Array.from(
    { length: input.expectedPageCount },
    (_, index) => index + 1,
  ).filter((pageNo) => !observedPages.has(pageNo));
  const ocrBlocks = input.blocks.filter(
    (block): block is DocumentBlock & { confidence: number } =>
      block.ocrEngine !== null && block.confidence !== null,
  );
  const allText = input.blocks.map((block) => block.text).join('');
  const garbledCount = [...allText].filter((character) => isGarbled(character)).length;
  const childChunks = input.chunks.filter((chunk) => chunk.granularity === 'CHILD');
  const duplicateChildren = childChunks.filter((chunk) => chunk.dedupStatus !== 'UNIQUE');
  const tables = input.blocks.filter((block) => block.type === 'TABLE');
  return {
    expectedPageCount: input.expectedPageCount,
    observedPageCount: observedPages.size,
    nonEmptyBlockRatio: ratio(nonEmptyBlocks.length, input.blocks.length),
    averageOcrConfidence:
      ocrBlocks.length === 0
        ? null
        : round(ocrBlocks.reduce((sum, block) => sum + block.confidence, 0) / ocrBlocks.length),
    garbledCharacterRatio: ratio(garbledCount, [...allText].length),
    duplicateChildRatio: ratio(duplicateChildren.length, childChunks.length),
    tableCount: tables.length,
    malformedTableCount: tables.filter((block) => isMalformedTable(block)).length,
    headingCount: input.blocks.filter((block) => block.type === 'TITLE').length,
    childChunkCount: childChunks.length,
    suppressedDuplicateCount: childChunks.filter(
      (chunk) => chunk.dedupStatus === 'SUPPRESSED_DUPLICATE',
    ).length,
    missingPageNos,
    hasResponsibleOwner: input.hasResponsibleOwner,
    versionConsistent: input.versionConsistent,
  };
}

function isMalformedTable(block: DocumentBlock): boolean {
  const table = block.table;
  if (!table || table.rows.length === 0 || table.headerRowCount > table.rows.length) return true;
  const width = table.rows[0]?.length ?? 0;
  return width === 0 || table.rows.some((row) => row.length !== width);
}

function isGarbled(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    character === '�' || character === '□' || (code < 32 && !['\n', '\r', '\t'].includes(character))
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

function finding(
  severity: QualityFindingDraft['severity'],
  code: string,
  message: string,
  metadata: Readonly<Record<string, unknown>> = {},
): QualityFindingDraft {
  return { severity, code, message, pageNos: [], blockIds: [], chunkIds: [], metadata };
}
