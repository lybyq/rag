<script setup lang="ts">
interface RoadmapItem {
  module: string;
  title: string;
  scope: string;
  status: 'active' | 'queued';
}

const roadmap: readonly RoadmapItem[] = [
  {
    module: 'M00',
    title: '工程与决策基线',
    scope: 'Monorepo · 契约 · 观测 · CI',
    status: 'active',
  },
  {
    module: 'M01—M03',
    title: '治理与文档接入',
    scope: '身份角色 · 上传任务 · 解析 OCR',
    status: 'queued',
  },
  {
    module: 'M04—M05',
    title: '知识加工与发布',
    scope: 'Chunk · 质量 · 向量索引 · 版本',
    status: 'queued',
  },
  {
    module: 'M06—M08',
    title: '可信问答链路',
    scope: 'Run · 混合检索 · 证据 · 校验',
    status: 'queued',
  },
  {
    module: 'M09—M10',
    title: '生产验收与产品闭环',
    scope: 'Eval · SLO · 压测 · 全链路 UI',
    status: 'queued',
  },
];
</script>

<template>
  <section class="roadmap-panel" aria-labelledby="roadmap-title">
    <span class="section-index">02 / DELIVERY MAP</span>
    <h2 id="roadmap-title">十一阶段，不跳步上线</h2>
    <div class="roadmap-list">
      <article
        v-for="item in roadmap"
        :key="item.module"
        :class="{ active: item.status === 'active' }"
      >
        <span>{{ item.module }}</span>
        <div>
          <strong>{{ item.title }}</strong
          ><small>{{ item.scope }}</small>
        </div>
        <i>{{ item.status === 'active' ? '建设中' : '待实施' }}</i>
      </article>
    </div>
  </section>
</template>

<style scoped>
.roadmap-panel {
  grid-column: span 5;
  padding: 26px;
  background: var(--surface-elevated);
  border: 1px solid var(--line-subtle);
}
.section-index {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.13em;
}
h2 {
  margin: 8px 0 24px;
  font-family: var(--font-editorial);
  font-size: 23px;
}
.roadmap-list {
  display: grid;
}
article {
  display: grid;
  grid-template-columns: 70px 1fr 50px;
  align-items: center;
  gap: 10px;
  min-height: 62px;
  border-top: 1px solid var(--line-subtle);
}
article > span,
article i {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
  font-style: normal;
}
article strong,
article small {
  display: block;
}
article strong {
  font-size: 12px;
}
article small {
  margin-top: 4px;
  color: var(--text-tertiary);
  font-size: 9px;
}
article i {
  text-align: right;
}
article.active {
  margin-inline: -10px;
  padding-inline: 10px;
  background: var(--accent-050);
  border-top-color: var(--accent-200);
}
article.active > span,
article.active i {
  color: var(--accent-700);
  font-weight: 700;
}
@media (max-width: 1100px) {
  .roadmap-panel {
    grid-column: span 12;
  }
}
</style>
