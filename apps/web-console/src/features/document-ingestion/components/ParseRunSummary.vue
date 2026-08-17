<script setup lang="ts">
/** 解析运行事实带：只展示服务端事实，不在浏览器推测安全或耗时结论。 */
import type { DocumentParseRun } from '@rag/contracts';

defineProps<{ run: DocumentParseRun }>();

const verdictLabels: Record<string, string> = {
  CLEAN: '安全通过',
  MANUAL_REVIEW: '等待复核',
  REJECTED: '已拒绝',
};

function verdictClass(verdict: DocumentParseRun['securityVerdict']): string {
  return verdict ? `verdict-${verdict.toLowerCase()}` : 'verdict-pending';
}

function duration(run: DocumentParseRun): string {
  const value = run.metrics.durationMs;
  return typeof value === 'number' ? `${(value / 1_000).toFixed(2)} s` : '—';
}
</script>

<template>
  <section class="run-summary" aria-label="解析运行摘要">
    <div class="run-lead" :class="verdictClass(run.securityVerdict)">
      <small>SECURITY</small>
      <strong>{{ verdictLabels[run.securityVerdict ?? ''] ?? '检查中' }}</strong>
      <span>{{ run.fileFormat ?? '待识别' }}</span>
    </div>
    <dl>
      <div>
        <dt>Parser</dt>
        <dd>{{ run.parserProfileId }}</dd>
        <small>{{ run.parserRevision }}</small>
      </div>
      <div>
        <dt>OCR</dt>
        <dd>{{ run.ocrPageCount }} 页</dd>
        <small>{{ run.ocrRevision }}</small>
      </div>
      <div>
        <dt>Blocks</dt>
        <dd>{{ run.blockCount }}</dd>
        <small>{{ run.pageCount }} 页 · r{{ run.contentRevision }}</small>
      </div>
      <div>
        <dt>耗时</dt>
        <dd>{{ duration(run) }}</dd>
        <small>{{ run.status }}</small>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.run-summary {
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr);
  border: 1px solid var(--line-strong);
  background: #fffdf8;
}
.run-lead {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 14px;
  border-right: 1px solid var(--line-strong);
}
.run-lead small,
dt {
  font-family: var(--font-mono);
  font-size: 8px;
  letter-spacing: 0.1em;
}
.run-lead strong {
  margin: 5px 0;
  font-family: var(--font-editorial);
  font-size: 16px;
}
.run-lead span,
dl small {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 8px;
}
.verdict-clean {
  box-shadow: inset 4px 0 #315d48;
}
.verdict-manual_review,
.verdict-pending {
  box-shadow: inset 4px 0 #bd7b1e;
}
.verdict-rejected {
  box-shadow: inset 4px 0 #a7463c;
}
dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
}
dl div {
  min-width: 0;
  padding: 10px 12px;
  border-right: 1px solid var(--line-subtle);
  border-bottom: 1px solid var(--line-subtle);
}
dt {
  color: var(--text-tertiary);
}
dd {
  overflow: hidden;
  margin: 4px 0 2px;
  font-size: 10px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
