<!-- Query Plan、Dense/Sparse、RRF、Rerank 摘要和剔除原因。 @requirement WEB-017 WEB-027 -->
<script setup lang="ts">
/* eslint-disable vue/html-indent, vue/multiline-html-element-content-newline -- 表格模板遵循 Prettier。 */
import { useRetrievalLab } from '../composables/useRetrievalLab';
const lab = useRetrievalLab();
</script>
<template>
  <section class="retrieval-lab">
    <form class="run-input" @submit.prevent="lab.execute">
      <ElInput
        v-model="lab.runId.value"
        placeholder="输入已创建且当前身份可见的 Run UUID"
        aria-label="Run UUID"
      /><ElButton
        native-type="submit"
        type="primary"
        :loading="lab.loading.value"
        :disabled="!lab.runId.value"
      >
        执行授权检索调试
      </ElButton>
    </form>
    <ElAlert
      v-if="lab.errorMessage.value"
      :title="lab.errorMessage.value"
      type="error"
      :closable="false"
    />
    <ElEmpty
      v-if="!lab.result.value && !lab.loading.value"
      description="输入问答 Run ID 后查看检索执行摘要"
    />
    <template v-else-if="lab.result.value">
      <div class="plan-facts">
        <article>
          <span>计划来源</span><strong>{{ lab.result.value.planSource }}</strong
          ><small>{{ lab.result.value.planSha256.slice(0, 16) }}…</small>
        </article>
        <article>
          <span>执行路由</span><strong>{{ lab.result.value.route }}</strong
          ><small
            >{{ lab.result.value.roundCount }} 轮 ·
            {{ lab.result.value.subQuestionCount }} 子问题</small
          >
        </article>
        <article>
          <span>缓存/降级</span
          ><strong>{{ lab.result.value.cacheHit ? 'CACHE HIT' : 'CACHE MISS' }}</strong
          ><small>{{ lab.result.value.degraded ? '已安全降级' : '双路正常' }}</small>
        </article>
      </div>
      <h3>Dense / Sparse 路线</h3>
      <div class="routes">
        <article v-for="route in lab.result.value.routes" :key="route.route">
          <strong>{{ route.route }}</strong
          ><ElTag effect="plain" :type="route.status === 'SUCCEEDED' ? 'success' : 'warning'">
            {{ route.status }} </ElTag
          ><span>{{ route.hitCount }} hits</span><small>{{ route.errorCode ?? '无错误' }}</small>
        </article>
      </div>
      <h3>RRF 候选与来源定位</h3>
      <ElTable :data="lab.result.value.candidates">
        <ElTableColumn prop="rank" label="#" width="60" /><ElTableColumn
          prop="title"
          label="来源"
          min-width="220"
        /><ElTableColumn label="章节" min-width="200">
          <template #default="{ row }">
            {{ row.headingPath.join(' / ') || '正文' }}
          </template> </ElTableColumn
        ><ElTableColumn prop="denseRank" label="Dense" width="85" /><ElTableColumn
          prop="sparseRank"
          label="Sparse"
          width="85"
        /><ElTableColumn prop="rrfScore" label="RRF" width="110" /><ElTableColumn
          prop="documentVersionId"
          label="版本 ID"
          min-width="220"
        />
      </ElTable>
      <div class="debug-bottom">
        <article>
          <h3>剔除原因摘要</h3>
          <p v-for="(count, reason) in lab.result.value.removedByReason" :key="reason">
            <span>{{ reason }}</span
            ><strong>{{ count }}</strong>
          </p>
        </article>
        <article>
          <h3>Reranker 节点摘要</h3>
          <pre>{{
            lab.rerank.value
              ? JSON.stringify(lab.rerank.value.outputSummary, null, 2)
              : '当前 Run 尚无 Reranker 节点事实'
          }}</pre>
        </article>
      </div>
      <ElAlert
        title="候选正文不会通过调试接口返回，防止绕过最终引用的逐次鉴权；来源预览只显示标题、章节和不可变版本标识。"
        type="info"
        :closable="false"
      />
    </template>
  </section>
</template>
<style scoped>
.retrieval-lab {
  padding: 24px;
  border: 1px solid var(--line-subtle);
  background: var(--surface-elevated);
}
.run-input {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto;
  gap: 9px;
}
.plan-facts,
.routes {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-top: 22px;
}
.plan-facts article,
.routes article {
  display: grid;
  gap: 7px;
  padding: 15px;
  border: 1px solid var(--line-subtle);
}
.plan-facts span,
.plan-facts small,
.routes small {
  color: var(--text-tertiary);
  font-size: 10px;
}
.plan-facts strong {
  font-family: var(--font-editorial);
  font-size: 20px;
}
.routes article {
  grid-template-columns: 1fr auto;
}
.routes span,
.routes small {
  grid-column: 1/-1;
}
h3 {
  margin-top: 28px;
  font-family: var(--font-editorial);
}
.debug-bottom {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 12px;
}
.debug-bottom article {
  padding: 15px;
  background: var(--surface-canvas);
}
.debug-bottom p {
  display: flex;
  justify-content: space-between;
}
.debug-bottom pre {
  overflow: auto;
  font-size: 10px;
}
@media (max-width: 800px) {
  .plan-facts,
  .routes,
  .debug-bottom {
    grid-template-columns: 1fr;
  }
  .run-input {
    grid-template-columns: 1fr;
  }
}
</style>
