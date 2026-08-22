import type { DocumentParseRun } from '@rag/contracts';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ParseRunSummary from './ParseRunSummary.vue';

const now = new Date().toISOString();
const run: DocumentParseRun = {
  providerProfile: 'test',
  id: '0198a8f4-12f8-7000-8000-111111111111',
  jobId: 'job-1',
  documentVersionId: '0198a8f4-12f8-7000-8000-222222222222',
  contentRevision: 2,
  status: 'SUCCEEDED',
  fileFormat: 'PDF',
  declaredMime: 'application/pdf',
  detectedMime: 'application/pdf',
  inputSha256: 'a'.repeat(64),
  securityVerdict: 'CLEAN',
  malwareEngine: 'RAG Builtin Content Safety',
  malwareRevision: '1.4',
  parserProfileId: 'docling-standard',
  parserRevision: 'docling-serve-v1',
  ocrProfileId: 'paddle-ocr',
  ocrRevision: '3.0',
  pageCount: 12,
  blockCount: 86,
  ocrPageCount: 2,
  derivedBucket: 'rag-derived',
  derivedObjectKey: 'derived/version/content-r2/parser-docling/blocks.json',
  derivedSha256: 'b'.repeat(64),
  failureClass: null,
  failureCode: null,
  failureMessage: null,
  metrics: { durationMs: 1_230 },
  startedAt: now,
  completedAt: now,
  createdAt: now,
  updatedAt: now,
};

describe('ParseRunSummary', () => {
  it('[PAR-015] 展示安全结论、Provider 修订、OCR 页和真实耗时', () => {
    const wrapper = mount(ParseRunSummary, { props: { run } });
    expect(wrapper.text()).toContain('安全通过');
    expect(wrapper.text()).toContain('docling-standard');
    expect(wrapper.text()).toContain('2 页');
    expect(wrapper.text()).toContain('1.23 s');
    expect(wrapper.text()).toContain('86');
  });
});
