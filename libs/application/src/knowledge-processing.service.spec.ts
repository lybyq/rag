/**
 * M04 知识加工编排测试。
 * 通过内存端口证明步骤顺序、质量三态和失败提交，不依赖 PostgreSQL 或 NestJS。
 *
 * @requirement KNO-003
 * @requirement KNO-009
 * @requirement KNO-010
 * @requirement KNO-013
 */
import { Cl100kTextTokenizer } from '@rag/chunking';
import type { DocumentBlock, KnowledgeProcessingRun } from '@rag/contracts';
import type {
  CompleteKnowledgeProcessingCommand,
  KnowledgeProcessingInput,
  KnowledgeProcessingRepository,
} from './knowledge-processing.ports';
import { KnowledgeProcessingService } from './knowledge-processing.service';

const jobId = 'ingest:22222222-2222-4222-8222-222222222222:revision:1:pipeline:v1';
const run: KnowledgeProcessingRun = {
  id: '33333333-3333-4333-8333-333333333333',
  jobId,
  providerProfile: 'test',
  parseRunId: '11111111-1111-4111-8111-111111111111',
  documentVersionId: '22222222-2222-4222-8222-222222222222',
  contentRevision: 1,
  fileFormat: 'DOCX',
  status: 'RUNNING',
  chunkerProfileId: 'structure-aware-medium',
  chunkerRevision: '1',
  tokenizerProfileId: 'cl100k-base-local',
  tokenizerRevision: 'js-tiktoken-1.0.21:cl100k_base',
  qualityRuleVersion: '1',
  parentChunkCount: 0,
  childChunkCount: 0,
  relationCount: 0,
  failureCode: null,
  failureMessage: null,
  metrics: {},
  startedAt: '2026-08-18T00:00:00.000Z',
  completedAt: null,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
};

function documentBlock(): DocumentBlock {
  return {
    id: 'block-1',
    parseRunId: run.parseRunId,
    documentVersionId: run.documentVersionId,
    contentRevision: 1,
    ordinal: 1,
    type: 'PARAGRAPH',
    text: '企业知识加工使用结构感知切块。',
    originalText: '企业知识加工使用结构感知切块。',
    pageNo: 1,
    sheetName: null,
    slideNo: null,
    bbox: null,
    headingLevel: null,
    parentBlockId: null,
    confidence: null,
    table: null,
    parserName: 'fixture',
    parserRevision: '1',
    ocrEngine: null,
    ocrRevision: null,
    metadata: {},
    contentSha256: 'a'.repeat(64),
    createdAt: '2026-08-18T00:00:00.000Z',
  };
}

function input(overrides: Partial<KnowledgeProcessingInput> = {}): KnowledgeProcessingInput {
  return {
    jobId,
    documentId: '44444444-4444-4444-8444-444444444444',
    documentVersionId: run.documentVersionId,
    contentRevision: 1,
    parseRunId: run.parseRunId,
    fileFormat: 'DOCX',
    expectedPageCount: 1,
    hasResponsibleOwner: true,
    versionConsistent: true,
    blocks: [documentBlock()],
    ...overrides,
  };
}

function repositoryFor(value: KnowledgeProcessingInput): {
  repository: jest.Mocked<KnowledgeProcessingRepository>;
  completed: CompleteKnowledgeProcessingCommand[];
} {
  const completed: CompleteKnowledgeProcessingCommand[] = [];
  const repository: jest.Mocked<KnowledgeProcessingRepository> = {
    loadInput: jest.fn().mockResolvedValue(value),
    beginRun: jest.fn().mockResolvedValue(run),
    startStep: jest.fn().mockResolvedValue(undefined),
    complete: jest.fn(async (command) => {
      completed.push(command);
    }),
    fail: jest.fn().mockResolvedValue(undefined),
    listRuns: jest.fn(),
    getRun: jest.fn(),
    listChunks: jest.fn(),
    review: jest.fn(),
  };
  return { repository, completed };
}

function service(repository: KnowledgeProcessingRepository): KnowledgeProcessingService {
  return new KnowledgeProcessingService(repository, new Cl100kTextTokenizer(), {
    providerProfile: 'test',
    chunkerProfileId: 'structure-aware-medium',
    chunkerRevision: '1',
    qualityRuleVersion: 'quality-medium-v1',
    chunking: {
      childMaxTokens: 80,
      parentMaxTokens: 180,
      overlapTokens: 8,
      dedupMode: 'SUPPRESS',
    },
    quality: {
      minimumNonEmptyBlockRatio: 0.6,
      rejectNonEmptyBlockRatio: 0.2,
      minimumOcrConfidence: 0.75,
      maximumGarbledRatio: 0.03,
      rejectGarbledRatio: 0.15,
      maximumDuplicateRatio: 0.4,
      requireHeadingAfterBlocks: 5,
    },
  });
}

describe('[CFG-007][KNO-003][KNO-009][KNO-010] KnowledgeProcessingService', () => {
  it('结构切块后再执行质量门禁，并一次提交 PASS 事实', async () => {
    const fixture = repositoryFor(input());
    const outcome = await service(fixture.repository).process(jobId, 'worker-1');

    expect(outcome).toBe('PASS');
    expect(fixture.repository.beginRun).toHaveBeenCalledWith(
      expect.objectContaining({ providerProfile: 'test' }),
    );
    expect(fixture.repository.startStep.mock.calls.map((call) => call[2])).toEqual([
      'CHUNK',
      'QUALITY_GATE',
    ]);
    expect(fixture.completed[0]?.chunks.some((chunk) => chunk.granularity === 'CHILD')).toBe(true);
    expect(fixture.completed[0]?.quality.verdict).toBe('PASS');
  });

  it('版本冲突生成 REJECT，不能继续成为索引资格', async () => {
    const fixture = repositoryFor(input({ versionConsistent: false }));
    const outcome = await service(fixture.repository).process(jobId, 'worker-1');

    expect(outcome).toBe('REJECT');
    expect(fixture.completed[0]?.quality.findings.map((item) => item.code)).toContain(
      'QUALITY_VERSION_CONFLICT',
    );
  });

  it('算法异常提交稳定失败而不把任务伪装为通过', async () => {
    const fixture = repositoryFor(input());
    fixture.repository.beginRun.mockRejectedValueOnce(new Error('合成算法异常'));
    const outcome = await service(fixture.repository).process(jobId, 'worker-1');

    expect(outcome).toBe('FAILED');
    expect(fixture.repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'KNOWLEDGE_PROCESSING_FAILED' }),
    );
    expect(fixture.repository.complete).not.toHaveBeenCalled();
  });
});
