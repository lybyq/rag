/**
 * 非生产 Fixture Adapter。
 * 它让没有真实 Parser/OCR 的 CI 演练完整编排，但输出带明确警告，生产配置会拒绝启动。
 */
import type {
  MalwareScannerPort,
  OcrPort,
  ParserPort,
  ProviderDocumentSource,
} from '@rag/application';
import type {
  MalwareScanResult,
  OcrResult,
  OcrTarget,
  ParserResult,
  ProcessingProviderProfile,
} from '@rag/contracts';

export class FixtureMalwareScannerAdapter implements MalwareScannerPort {
  public constructor(
    private readonly profileId: string,
    private readonly revision: string,
    private readonly timeoutMs: number,
  ) {}

  public profile(): ProcessingProviderProfile {
    return fixtureProfile('MALWARE_SCANNER', this.profileId, this.revision, this.timeoutMs);
  }

  public async scan(content: AsyncIterable<Uint8Array>): Promise<MalwareScanResult> {
    let scannedBytes = 0;
    for await (const chunk of content) scannedBytes += chunk.byteLength;
    return {
      verdict: 'CLEAN',
      engine: 'fixture-scanner',
      engineRevision: this.revision,
      signatureName: null,
      scannedBytes,
      durationMs: 0,
    };
  }
}

export class FixtureParserAdapter implements ParserPort {
  public constructor(
    private readonly profileId: string,
    private readonly revision: string,
    private readonly protocolVersion: string,
    private readonly timeoutMs: number,
  ) {}

  public profile(): ProcessingProviderProfile {
    return fixtureProfile('PARSER', this.profileId, this.revision, this.timeoutMs);
  }

  public async parse(source: ProviderDocumentSource): Promise<ParserResult> {
    const imageLike = source.format === 'IMAGE';
    return {
      parserName: 'fixture-parser',
      parserRevision: this.revision,
      protocolVersion: this.protocolVersion,
      blocks: imageLike
        ? []
        : [
            {
              type: 'PARAGRAPH',
              text: `[Fixture] ${source.fileName}`,
              originalText: `[Fixture] ${source.fileName}`,
              pageNo: 1,
              sheetName: null,
              slideNo: null,
              bbox: null,
              headingLevel: null,
              confidence: null,
              table: null,
              metadata: { fixture: true, format: source.format },
            },
          ],
      pages: [
        {
          pageNo: 1,
          textCharacterCount: imageLike ? 0 : source.fileName.length,
          textCoverage: imageLike ? 0 : 0.5,
          imageOnly: imageLike,
        },
      ],
      ocrCandidates: imageLike
        ? [
            {
              targetId: 'whole-image',
              kind: 'WHOLE_IMAGE',
              pageNo: 1,
              slideNo: null,
              sheetName: null,
              bbox: null,
              assetRef: {
                storage: 'SOURCE_DOCUMENT',
                archiveEntryPath: null,
                mediaType: source.declaredMime,
              },
              reason: 'IMAGE_ONLY',
            },
          ]
        : [],
      inspection: {
        encrypted: false,
        hasMacros: false,
        embeddedObjectCount: 0,
        externalLinkCount: 0,
        archiveDepth: null,
        compressedSizeBytes: null,
        uncompressedSizeBytes: null,
        pageCount: 1,
        totalPixels: null,
        tableCellCount: 0,
      },
      durationMs: 0,
      warnings: ['FIXTURE_PARSER_NOT_FOR_PRODUCTION'],
    };
  }
}

export class FixtureOcrAdapter implements OcrPort {
  public constructor(
    private readonly profileId: string,
    private readonly revision: string,
    private readonly protocolVersion: string,
    private readonly timeoutMs: number,
  ) {}

  public profile(): ProcessingProviderProfile {
    return fixtureProfile('OCR', this.profileId, this.revision, this.timeoutMs);
  }

  public async recognize(
    _source: ProviderDocumentSource,
    targets: readonly OcrTarget[],
  ): Promise<OcrResult> {
    return {
      engine: 'fixture-ocr',
      engineRevision: this.revision,
      protocolVersion: this.protocolVersion,
      results: targets.map((target) => ({
        targetId: target.targetId,
        pageNo: target.pageNo,
        averageConfidence: 1,
        blocks: [
          {
            type: 'PARAGRAPH',
            text: `[Fixture OCR] target ${target.targetId}`,
            originalText: `[Fixture OCR] target ${target.targetId}`,
            pageNo: target.pageNo,
            sheetName: target.sheetName,
            slideNo: target.slideNo,
            bbox: target.bbox,
            headingLevel: null,
            confidence: 1,
            table: null,
            metadata: {
              fixture: true,
              extractionSource: 'OCR',
              sourceTargetId: target.targetId,
            },
          },
        ],
      })),
      durationMs: 0,
      warnings: ['FIXTURE_OCR_NOT_FOR_PRODUCTION'],
    };
  }
}

function fixtureProfile(
  kind: ProcessingProviderProfile['kind'],
  profileId: string,
  revision: string,
  timeoutMs: number,
): ProcessingProviderProfile {
  return {
    kind,
    adapter: 'fixture',
    profileId,
    revision,
    protocolVersion: 'fixture-v1',
    endpoint: null,
    capabilities: ['DEVELOPMENT_ONLY'],
    timeoutMs,
  };
}
