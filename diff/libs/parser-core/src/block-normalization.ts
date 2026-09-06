/**
 * 把 Parser/OCR 候选项转换为稳定、可定位的 Block 草稿。
 * 本层只做纯函数规范化和稳定标识，不写数据库，也不生成 知识加工与质量 的 Chunk。
 *
 * @requirement PAR-007
 * @requirement PAR-008
 * @requirement PAR-009
 * @requirement PAR-010
 * @requirement PAR-011
 * @requirement PAR-012
 */
import type {
  OcrTarget,
  OcrTargetResult,
  ParsedBlockCandidate,
  ParsedPage,
  SupportedFileFormat,
} from '@rag/contracts';
import { createHash } from 'node:crypto';

/** 持久化前的 Block 草稿；createdAt 由 PostgreSQL 统一产生。 */
export interface DocumentBlockDraft extends ParsedBlockCandidate {
  readonly id: string;
  readonly parseRunId: string;
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly ordinal: number;
  readonly parentBlockId: string | null;
  readonly parserName: string;
  readonly parserRevision: string;
  readonly ocrEngine: string | null;
  readonly ocrRevision: string | null;
  readonly contentSha256: string;
}

/** 构建 Block 所需的版本化上下文。 */
export interface BuildDocumentBlocksInput {
  readonly parseRunId: string;
  readonly documentVersionId: string;
  readonly contentRevision: number;
  readonly parserName: string;
  readonly parserRevision: string;
  readonly ocrEngine?: string;
  readonly ocrRevision?: string;
  readonly candidates: readonly ParsedBlockCandidate[];
}

/** 统一换行和行内空白，但绝不修改 originalText。 */
export function normalizeBlockText(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** SHA-256 始终返回小写十六进制，供 PG CHECK 和 MinIO metadata 共同验证。 */
export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 为当前候选顺序生成从 1 开始的 ordinal 和稳定 ID。
 * ID 包含内容修订和 ordinal，因此同一修订重试稳定，不同修订不会错误覆盖。
 */
export function buildDocumentBlocks(
  input: BuildDocumentBlocksInput,
): readonly DocumentBlockDraft[] {
  return input.candidates.map((candidate, index) => {
    const ordinal = index + 1;
    const text = normalizeBlockText(candidate.text);
    const contentSha256 = sha256Text(
      JSON.stringify({
        type: candidate.type,
        text,
        originalText: candidate.originalText,
        pageNo: candidate.pageNo,
        sheetName: candidate.sheetName,
        slideNo: candidate.slideNo,
        bbox: candidate.bbox,
        table: candidate.table,
      }),
    );
    const stableSuffix = sha256Text(
      `${input.documentVersionId}:${input.contentRevision}:${ordinal}:${contentSha256}`,
    ).slice(0, 32);
    return {
      ...candidate,
      text,
      id: `block-${stableSuffix}`,
      parseRunId: input.parseRunId,
      documentVersionId: input.documentVersionId,
      contentRevision: input.contentRevision,
      ordinal,
      parentBlockId: null,
      parserName: input.parserName,
      parserRevision: input.parserRevision,
      // 只有 OCR/MERGED Block 记录 OCR 引擎；可靠原生 Block 不能因同一文档调用过 OCR 就被错误标记。
      ocrEngine:
        candidate.metadata.extractionSource === 'OCR' ||
        candidate.metadata.extractionSource === 'MERGED'
          ? (input.ocrEngine ?? null)
          : null,
      ocrRevision:
        candidate.metadata.extractionSource === 'OCR' ||
        candidate.metadata.extractionSource === 'MERGED'
          ? (input.ocrRevision ?? null)
          : null,
      contentSha256,
    };
  });
}

/**
 * 只选择能够确定没有可靠原生文字的页面，并稳定去重排序。
 *
 * 字符覆盖率只是代理指标：封面标题、章节标题经常很短，不能仅凭字符少就删除原生内容。
 * 当前阶段只自动选择 `imageOnly` 或字符数确实为零的页面；混合页留给带版面事实的 PDF 策略判断。
 *
 * @requirement PAR-016
 */
export function selectOcrPages(
  pages: readonly ParsedPage[],
  textCoverageThreshold: number,
): readonly number[] {
  return [
    ...new Set(
      pages
        .filter(
          (page) =>
            page.imageOnly ||
            (page.textCharacterCount === 0 && page.textCoverage < textCoverageThreshold),
        )
        .map((page) => page.pageNo),
    ),
  ].sort((left, right) => left - right);
}

/**
 * 合并 Parser 主动发现的图片目标与按页覆盖率计算出的 PDF 目标。
 * targetId 是幂等键；同一目标重复出现时保留 Parser 提供的更具体定位。
 */
export function selectOcrTargets(
  pages: readonly ParsedPage[],
  parserCandidates: readonly OcrTarget[],
  textCoverageThreshold: number,
  format: SupportedFileFormat = 'PDF',
): readonly OcrTarget[] {
  const targets = new Map<string, OcrTarget>();
  for (const candidate of parserCandidates) targets.set(candidate.targetId, candidate);
  // 通用 PAGE OCR 只对 PDF 有明确语义。PPTX 的 page 实际是 Slide，XLSX 则没有 page；
  // 这些格式只能使用 Parser 给出的、带真实资源引用的显式候选，避免 Provider 收到无法处理的目标。
  const automaticPageNumbers = format === 'PDF' ? selectOcrPages(pages, textCoverageThreshold) : [];
  for (const pageNo of automaticPageNumbers) {
    const page = pages.find((item) => item.pageNo === pageNo);
    const targetId = `page-${pageNo}`;
    // 独立图片以“整份源文件”作为 OCR 输入；不能再为它生成 PAGE，否则同一字节会被识别两次。
    // EMBEDDED_IMAGE/REGION 只覆盖局部，不能据此抑制真正的整页 OCR。
    const coveredByWholeImage = [...targets.values()].some(
      (target) => target.kind === 'WHOLE_IMAGE' && target.pageNo === pageNo,
    );
    if (!targets.has(targetId) && !coveredByWholeImage) {
      targets.set(targetId, {
        targetId,
        kind: 'PAGE',
        pageNo,
        slideNo: null,
        sheetName: null,
        bbox: null,
        assetRef: { storage: 'SOURCE_DOCUMENT', archiveEntryPath: null, mediaType: null },
        reason: page?.imageOnly ? 'IMAGE_ONLY' : 'LOW_TEXT_COVERAGE',
      });
    }
  }
  return [...targets.values()].sort(compareOcrTargetLocation);
}

/** OCR 目标执行后的稳定质量状态；它不暴露供应商私有错误文本。 */
export type OcrTargetAssessmentStatus =
  | 'SUCCESS'
  | 'MISSING'
  | 'EMPTY'
  | 'LOW_CONFIDENCE'
  | 'INVALID_LOCATION'
  | 'DUPLICATE_RESULT';

/**
 * 单个 OCR 目标的质量判定。
 * `usableBlocks` 只有在状态为 SUCCESS 时才有内容，调用方不能绕过这个字段直接发布原始响应。
 */
export interface OcrTargetAssessment {
  readonly target: OcrTarget;
  readonly result: OcrTargetResult | null;
  readonly status: OcrTargetAssessmentStatus;
  readonly usableBlocks: readonly ParsedBlockCandidate[];
}

/**
 * 把一次 OCR 响应拆成逐目标结果，明确区分缺失、空结果、低置信度和位置错误。
 *
 * Http Adapter 会优先拒绝重复/错位响应；这里仍然防御性检查，使 Fixture 或未来 Adapter
 * 也不能绕过核心质量规则。
 *
 * @requirement PAR-016
 */
export function assessOcrTargetResults(
  targets: readonly OcrTarget[],
  results: readonly OcrTargetResult[],
  minimumConfidence: number,
): readonly OcrTargetAssessment[] {
  const resultsByTarget = new Map<string, OcrTargetResult[]>();
  for (const result of results) {
    const sameTarget = resultsByTarget.get(result.targetId) ?? [];
    sameTarget.push(result);
    resultsByTarget.set(result.targetId, sameTarget);
  }
  return targets.map((target) => {
    const matches = resultsByTarget.get(target.targetId) ?? [];
    if (matches.length === 0) return assessment(target, null, 'MISSING');
    if (matches.length > 1) return assessment(target, matches[0] ?? null, 'DUPLICATE_RESULT');
    const result = matches[0] as OcrTargetResult;
    if (!ocrResultMatchesTarget(result, target)) {
      return assessment(target, result, 'INVALID_LOCATION');
    }
    const nonEmptyBlocks = result.blocks.filter((block) => block.text.trim().length > 0);
    if (nonEmptyBlocks.length === 0) return assessment(target, result, 'EMPTY');
    if (result.averageConfidence < minimumConfidence) {
      return assessment(target, result, 'LOW_CONFIDENCE');
    }
    return { target, result, status: 'SUCCESS', usableBlocks: nonEmptyBlocks };
  });
}

/**
 * OCR Provider 能力过滤结果。空能力数组按旧 Provider“未声明”兼容处理；
 * 一旦声明任一目标能力，就只放行明确支持的目标类型。
 */
export interface OcrCapabilitySelection {
  readonly supported: readonly OcrTarget[];
  readonly unsupported: readonly OcrTarget[];
}

/** 根据低基数 capability 名称阻止把 Provider 不支持的目标发送到内网服务。 @requirement PAR-016 */
export function selectSupportedOcrTargets(
  targets: readonly OcrTarget[],
  capabilities: readonly string[],
): OcrCapabilitySelection {
  const capabilityByKind: Readonly<Record<OcrTarget['kind'], string>> = {
    PAGE: 'PAGE_SELECTIVE',
    REGION: 'REGION_TARGET',
    EMBEDDED_IMAGE: 'EMBEDDED_IMAGE_TARGET',
    WHOLE_IMAGE: 'WHOLE_IMAGE_TARGET',
  };
  const knownCapabilities = new Set(Object.values(capabilityByKind));
  const declaredCapabilities = new Set(
    capabilities.filter((capability) => knownCapabilities.has(capability)),
  );
  if (declaredCapabilities.size === 0) return { supported: [...targets], unsupported: [] };
  const supported: OcrTarget[] = [];
  const unsupported: OcrTarget[] = [];
  for (const target of targets) {
    (declaredCapabilities.has(capabilityByKind[target.kind]) ? supported : unsupported).push(
      target,
    );
  }
  return { supported, unsupported };
}

/**
 * 只合并质量判定为 SUCCESS 的 OCR Block。
 * PAGE 成功时替换对应原生页；有 `metadata.ocrTargetId` 的局部图片 OCR 紧跟锚点插入，
 * REGION/EMBEDDED_IMAGE/WHOLE_IMAGE 在找不到锚点时仍按原定位稳定补充。
 *
 * @requirement PAR-016
 * @requirement PAR-021
 */
export function mergeOcrBlocks(
  parserBlocks: readonly ParsedBlockCandidate[],
  assessments: readonly OcrTargetAssessment[],
): readonly ParsedBlockCandidate[] {
  const replacedPages = new Set(
    assessments
      .filter(
        (item) =>
          item.status === 'SUCCESS' && item.target.kind === 'PAGE' && item.target.pageNo !== null,
      )
      .map((item) => item.target.pageNo as number),
  );
  const native = parserBlocks.filter(
    (block) => block.pageNo === null || !replacedPages.has(block.pageNo),
  );
  const anchoredOcr = new Map<string, ParsedBlockCandidate[]>();
  const unanchoredOcr: ParsedBlockCandidate[] = [];
  for (const item of assessments) {
    if (item.status !== 'SUCCESS') continue;
    const usable = item.usableBlocks.map((block) => ({
      ...block,
      metadata: {
        ...block.metadata,
        ocrTargetId: item.target.targetId,
        anchorTargetKind: item.target.kind,
      },
    }));
    const hasNativeAnchor = native.some(
      (block) => block.metadata.ocrTargetId === item.target.targetId,
    );
    if (item.target.kind !== 'PAGE' && hasNativeAnchor) {
      anchoredOcr.set(item.target.targetId, usable);
    } else {
      unanchoredOcr.push(...usable);
    }
  }

  const merged: ParsedBlockCandidate[] = [];
  for (const block of native) {
    merged.push(block);
    const targetId = block.metadata.ocrTargetId;
    if (typeof targetId === 'string') merged.push(...(anchoredOcr.get(targetId) ?? []));
  }
  return [...merged, ...unanchoredOcr].sort(compareBlockLocation);
}

/** 构造无可用 Block 的非成功判定，避免各分支忘记清空不可信 OCR 内容。 */
function assessment(
  target: OcrTarget,
  result: OcrTargetResult | null,
  status: Exclude<OcrTargetAssessmentStatus, 'SUCCESS'>,
): OcrTargetAssessment {
  return { target, result, status, usableBlocks: [] };
}

/** 防御性验证结果及其 Block 没有偏离请求目标的页、Slide 或 Sheet。 */
function ocrResultMatchesTarget(result: OcrTargetResult, target: OcrTarget): boolean {
  if (result.pageNo !== target.pageNo) return false;
  return result.blocks.every(
    (block) =>
      block.pageNo === target.pageNo &&
      block.slideNo === target.slideNo &&
      block.sheetName === target.sheetName,
  );
}

/** OCR 目标按页、Slide、Sheet、bbox 和 ID 排序，保证同一 revision 输出稳定。 */
function compareOcrTargetLocation(left: OcrTarget, right: OcrTarget): number {
  const leftPage = left.pageNo ?? left.slideNo ?? Number.MAX_SAFE_INTEGER;
  const rightPage = right.pageNo ?? right.slideNo ?? Number.MAX_SAFE_INTEGER;
  if (leftPage !== rightPage) return leftPage - rightPage;
  const sheetComparison = (left.sheetName ?? '').localeCompare(right.sheetName ?? '');
  if (sheetComparison !== 0) return sheetComparison;
  if (left.bbox && right.bbox) {
    if (left.bbox.y1 !== right.bbox.y1) return left.bbox.y1 - right.bbox.y1;
    if (left.bbox.x1 !== right.bbox.x1) return left.bbox.x1 - right.bbox.x1;
  }
  return left.targetId.localeCompare(right.targetId);
}

/** 阅读顺序优先页/Slide，再按坐标；无坐标项保持 Provider 原始稳定顺序。 */
function compareBlockLocation(left: ParsedBlockCandidate, right: ParsedBlockCandidate): number {
  const leftPage = left.pageNo ?? left.slideNo ?? Number.MAX_SAFE_INTEGER;
  const rightPage = right.pageNo ?? right.slideNo ?? Number.MAX_SAFE_INTEGER;
  if (leftPage !== rightPage) return leftPage - rightPage;
  if (left.bbox && right.bbox) {
    if (left.bbox.y1 !== right.bbox.y1) return left.bbox.y1 - right.bbox.y1;
    return left.bbox.x1 - right.bbox.x1;
  }
  return 0;
}

/**
 * derived Key 只包含服务端 ID、内容修订、净化 Profile 与 Parser 算法修订，不含用户文件名。
 * revision 必须进入路径；只依赖对象 metadata/hash 会让新算法先覆盖旧对象，失去并行验收和安全回滚能力。
 */
export function buildDerivedSnapshotKey(
  documentVersionId: string,
  contentRevision: number,
  parserProfileId: string,
  parserRevision: string,
): string {
  const safeProfile = sanitizeDerivedPathSegment(parserProfileId, 'parserProfileId');
  const safeRevision = sanitizeDerivedPathSegment(parserRevision, 'parserRevision');
  return `derived/${documentVersionId}/content-r${contentRevision}/parser-${safeProfile}/revision-${safeRevision}/blocks.json`;
}

/** 把配置身份限制为单个对象路径段，防止 `/`、`..` 或空白改变派生对象作用域。 */
function sanitizeDerivedPathSegment(value: string, fieldName: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error(`${fieldName} 净化后不是安全路径段`);
  }
  return sanitized;
}
