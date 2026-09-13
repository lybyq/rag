/**
 * 内网标准 OCR HTTP Adapter：提交明确目标并把供应商响应收敛为平台 OCR v2 契约。
 * 本层校验目标唯一性和位置，不判断内容质量，也不决定是否替换原生正文。
 *
 * @requirement PAR-005
 * @requirement PAR-016
 */
import type { OcrPort, ProviderDocumentSource } from '@rag/application';
import type { OcrResult, OcrTarget, ProcessingProviderProfile } from '@rag/contracts';
import { OcrResultSchema } from '@rag/contracts';
import type { FetchImplementation, ProviderHttpClientConfig } from './http-json.client';
import { postProviderJson, postProviderText } from './http-json.client';
import { ProcessingProviderError } from './provider.error';

/** 标准 OCR HTTP Adapter 的版本化连接配置。 */
export interface HttpOcrConfig extends ProviderHttpClientConfig {
  readonly profileId: string;
  readonly revision: string;
  readonly protocolVersion: string;
  readonly modelId: string;
  /** 响应形状由运维按实际接口选择；禁止运行时根据正文猜测。 */
  readonly responseFormat?: 'platform-json' | 'text' | 'json-string' | 'json-text-field';
  /** JSON 文本字段模式使用的顶层字段名。 */
  readonly jsonTextField?: string;
  /** Provider 实际支持的目标类型；省略时保持旧配置的全能力行为。 */
  readonly capabilities?: readonly string[];
}

/** 隔离内网 OCR 协议差异、远程错误和目标关联校验。 */
export class HttpOcrAdapter implements OcrPort {
  public constructor(
    private readonly config: HttpOcrConfig,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public profile(): ProcessingProviderProfile {
    return {
      kind: 'OCR',
      adapter: 'http',
      profileId: this.config.profileId,
      revision: this.config.revision,
      protocolVersion: this.config.protocolVersion,
      endpoint: this.config.baseUrl,
      capabilities: [
        ...(this.config.capabilities ?? [
          'PAGE_SELECTIVE',
          'REGION_TARGET',
          'EMBEDDED_IMAGE_TARGET',
          'WHOLE_IMAGE_TARGET',
          'BBOX',
          'CONFIDENCE',
        ]),
      ],
      timeoutMs: this.config.timeoutMs,
    };
  }

  public async recognize(
    source: ProviderDocumentSource,
    targets: readonly OcrTarget[],
    signal: AbortSignal,
  ): Promise<OcrResult> {
    const requested = uniqueRequestedTargets(targets);
    const responseFormat = this.config.responseFormat ?? 'platform-json';
    if (responseFormat !== 'platform-json' && requested.size !== 1) {
      throw contractError(
        'OCR_PLAIN_TEXT_MULTI_TARGET_UNSUPPORTED',
        '纯文本 OCR 一次只能关联一个实际目标，禁止把整段结果复制到多个页面',
      );
    }
    const startedAt = Date.now();
    const requestBody = { protocolVersion: this.config.protocolVersion, source, targets };
    const raw =
      responseFormat === 'text'
        ? await postProviderText(
            this.config,
            'v1/ocr',
            requestBody,
            signal,
            this.fetchImplementation,
          )
        : await postProviderJson(
            this.config,
            'v1/ocr',
            requestBody,
            signal,
            this.fetchImplementation,
          );
    if (responseFormat !== 'platform-json') {
      return plainTextResult(
        raw,
        responseFormat,
        this.config,
        requested.values().next().value as OcrTarget,
        Date.now() - startedAt,
      );
    }
    const parsed = OcrResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'OCR_SCHEMA_MISMATCH',
        'OCR 响应不符合平台契约',
        { cause: parsed.error },
      );
    }
    if (parsed.data.protocolVersion !== this.config.protocolVersion) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'OCR_PROTOCOL_VERSION_MISMATCH',
        'OCR 协议版本与配置不一致',
      );
    }
    if (parsed.data.engineRevision !== this.config.revision) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'OCR_REVISION_MISMATCH',
        'OCR 实际修订与配置 Profile 不一致',
      );
    }
    const returnedTargetIds = new Set<string>();
    for (const result of parsed.data.results) {
      if (returnedTargetIds.has(result.targetId)) {
        throw contractError('OCR_DUPLICATE_TARGET_RESULT', 'OCR 对同一目标返回了重复结果');
      }
      returnedTargetIds.add(result.targetId);
      const target = requested.get(result.targetId);
      if (!target) {
        throw contractError('OCR_UNREQUESTED_TARGET', 'OCR 返回了调用方未请求的目标');
      }
      assertResultLocation(result, target);
    }
    const hasMissingTarget = [...requested.keys()].some(
      (targetId) => !returnedTargetIds.has(targetId),
    );
    return OcrResultSchema.parse({
      ...parsed.data,
      warnings: hasMissingTarget
        ? [...new Set([...parsed.data.warnings, 'OCR_TARGET_RESULT_MISSING'])]
        : parsed.data.warnings,
      results: parsed.data.results.map((result) => ({
        ...result,
        blocks: result.blocks.map((block) => ({
          ...block,
          // targetId 已通过唯一性校验，因此可以用请求中的可信位置补齐旧版内网 Provider 的空定位。
          pageNo: block.pageNo ?? requested.get(result.targetId)?.pageNo ?? null,
          slideNo: block.slideNo ?? requested.get(result.targetId)?.slideNo ?? null,
          sheetName: block.sheetName ?? requested.get(result.targetId)?.sheetName ?? null,
          metadata: {
            ...block.metadata,
            extractionSource: 'OCR',
            sourceTargetId: result.targetId,
          },
        })),
      })),
    });
  }
}

/** 把显式配置的纯文本响应映射成单目标结果，未知坐标与置信度保持 null。 */
function plainTextResult(
  raw: unknown,
  responseFormat: Exclude<NonNullable<HttpOcrConfig['responseFormat']>, 'platform-json'>,
  config: HttpOcrConfig,
  target: OcrTarget,
  durationMs: number,
): OcrResult {
  const text = extractConfiguredText(raw, responseFormat, config.jsonTextField ?? 'text').trim();
  if (!text) throw contractError('OCR_EMPTY_TEXT_RESPONSE', 'OCR 返回了空白纯文本');
  if (/^\s*<(?:!doctype\s+html|html|body)\b/iu.test(text)) {
    throw contractError('OCR_HTML_ERROR_RESPONSE', 'OCR 返回了 HTML 错误页而不是识别文本');
  }
  return OcrResultSchema.parse({
    engine: config.modelId,
    engineRevision: config.revision,
    protocolVersion: config.protocolVersion,
    results: [
      {
        targetId: target.targetId,
        pageNo: target.pageNo,
        averageConfidence: null,
        blocks: [
          {
            type: 'PARAGRAPH',
            text,
            originalText: text,
            pageNo: target.pageNo,
            sheetName: target.sheetName,
            slideNo: target.slideNo,
            bbox: null,
            headingLevel: null,
            confidence: null,
            table: null,
            metadata: {
              extractionSource: 'OCR',
              sourceTargetId: target.targetId,
              locationPrecision: 'TARGET_ONLY',
            },
          },
        ],
      },
    ],
    durationMs,
    warnings: ['OCR_CONFIDENCE_UNAVAILABLE', 'OCR_FINE_LOCATION_UNAVAILABLE'],
  });
}

/** 只接受所选响应形状，不在字符串、对象和嵌套字段之间做隐式兜底。 */
function extractConfiguredText(
  raw: unknown,
  responseFormat: Exclude<NonNullable<HttpOcrConfig['responseFormat']>, 'platform-json'>,
  jsonTextField: string,
): string {
  if ((responseFormat === 'text' || responseFormat === 'json-string') && typeof raw === 'string') {
    return raw;
  }
  if (
    responseFormat === 'json-text-field' &&
    typeof raw === 'object' &&
    raw !== null &&
    jsonTextField in raw &&
    typeof (raw as Record<string, unknown>)[jsonTextField] === 'string'
  ) {
    return (raw as Record<string, string>)[jsonTextField] ?? '';
  }
  throw contractError('OCR_TEXT_RESPONSE_SCHEMA_MISMATCH', 'OCR 纯文本响应与所选配置不一致');
}

/** 请求目标重复属于调用方缺陷；在发出网络请求前失败，避免 Provider 产生歧义结果。 */
function uniqueRequestedTargets(targets: readonly OcrTarget[]): ReadonlyMap<string, OcrTarget> {
  const requested = new Map<string, OcrTarget>();
  for (const target of targets) {
    if (requested.has(target.targetId)) {
      throw contractError('OCR_DUPLICATE_REQUEST_TARGET', 'OCR 请求包含重复目标');
    }
    requested.set(target.targetId, target);
  }
  return requested;
}

/** 校验结果和每个 Block 的页、Slide、Sheet 没有偏离请求目标。 */
function assertResultLocation(result: OcrResult['results'][number], target: OcrTarget): void {
  if (result.pageNo !== target.pageNo) {
    throw contractError('OCR_TARGET_LOCATION_MISMATCH', 'OCR 结果页码与请求目标不一致');
  }
  for (const block of result.blocks) {
    if (
      locationConflicts(block.pageNo, target.pageNo) ||
      locationConflicts(block.slideNo, target.slideNo) ||
      locationConflicts(block.sheetName, target.sheetName)
    ) {
      throw contractError('OCR_TARGET_LOCATION_MISMATCH', 'OCR Block 定位与请求目标不一致');
    }
  }
}

/** Provider 允许省略平台可从 targetId 恢复的位置，但不允许返回冲突位置。 */
function locationConflicts<T extends number | string>(
  actual: T | null,
  expected: T | null,
): boolean {
  return actual !== null && actual !== expected;
}

/** 构造不会被业务层按自然语言猜测的稳定 OCR 契约错误。 */
function contractError(code: string, message: string): ProcessingProviderError {
  return new ProcessingProviderError('DEVELOPER_DEFECT', code, message);
}
