<script setup lang="ts">
const decisions = [
  ['运行时契约', 'Zod 同时生成 TypeScript 类型与 OpenAPI，拒绝“文档正确、运行错误”。'],
  ['依赖方向', 'Domain 与 Application 不认识 NestJS、Prisma、Milvus 或模型 SDK。'],
  ['可替换能力', 'Milvus、LLM、Embedding、Reranker、OCR 均从 Provider 配置切换。'],
] as const;
</script>

<template>
  <section class="architecture-notes" aria-labelledby="architecture-title">
    <div class="notes-heading">
      <span class="section-index">03 / DECISION NOTES</span>
      <h2 id="architecture-title">先固定规则，再增加能力</h2>
    </div>
    <article v-for="([title, description], index) in decisions" :key="title">
      <span>0{{ index + 1 }}</span>
      <div>
        <strong>{{ title }}</strong>
        <p>{{ description }}</p>
      </div>
    </article>
  </section>
</template>

<style scoped>
.architecture-notes {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 1.15fr repeat(3, 1fr);
  border-block: 1px solid var(--line-strong);
}
.notes-heading,
article {
  min-height: 168px;
  padding: 25px;
}
.notes-heading {
  background: var(--accent-500);
  color: var(--ink-950);
}
.section-index {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.13em;
}
h2 {
  max-width: 250px;
  margin: 23px 0 0;
  font-family: var(--font-editorial);
  font-size: 24px;
  line-height: 1.2;
}
article {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 8px;
  border-right: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
}
article > span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
}
article strong {
  font-size: 13px;
}
article p {
  margin: 14px 0 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.8;
}
@media (max-width: 1000px) {
  .architecture-notes {
    grid-template-columns: 1fr;
  }
  .notes-heading,
  article {
    min-height: auto;
  }
}
</style>
