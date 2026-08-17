<script setup lang="ts">
/** M04 审核输入弹窗；只收集 action/reason，服务端仍重新鉴权并校验乐观锁。 */
import type { DocumentQualityReport, QualityReviewAction } from '@rag/contracts';
import { computed, reactive, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  report: DocumentQualityReport;
  submitting: boolean;
  errorMessage: string;
}>();
const emit = defineEmits<{
  'update:open': [open: boolean];
  submit: [request: { action: QualityReviewAction; expectedVersion: number; reason: string }];
}>();
const form = reactive<{ action: QualityReviewAction; reason: string }>({
  action: props.report.verdict === 'REJECT' ? 'REQUEST_REPROCESS' : 'APPROVE',
  reason: '',
});
const canApprove = computed(() => props.report.verdict === 'MANUAL_REVIEW');
const canSubmit = computed(() => form.reason.trim().length >= 2 && !props.submitting);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.action = props.report.verdict === 'REJECT' ? 'REQUEST_REPROCESS' : 'APPROVE';
    form.reason = '';
  },
);

function submit(): void {
  if (!canSubmit.value) return;
  emit('submit', {
    action: form.action,
    expectedVersion: props.report.optimisticVersion,
    reason: form.reason.trim(),
  });
}
</script>

<template>
  <ElDialog
    :model-value="open"
    title="质量审核裁决"
    width="520px"
    destroy-on-close
    :close-on-click-modal="false"
    @update:model-value="emit('update:open', $event)"
  >
    <div class="review-ledger">
      <span>AUTOMATIC VERDICT</span>
      <strong>{{ report.verdict }}</strong>
      <code>report v{{ report.optimisticVersion }}</code>
    </div>
    <div class="action-strip" aria-label="选择审核动作">
      <ElButton
        v-if="canApprove"
        :type="form.action === 'APPROVE' ? 'success' : 'default'"
        plain
        data-testid="review-action-approve"
        @click="form.action = 'APPROVE'"
      >
        批准
      </ElButton>
      <ElButton
        :type="form.action === 'REJECT' ? 'danger' : 'default'"
        plain
        data-testid="review-action-reject"
        @click="form.action = 'REJECT'"
      >
        拒绝
      </ElButton>
      <ElButton
        :type="form.action === 'REQUEST_REPROCESS' ? 'warning' : 'default'"
        plain
        data-testid="review-action-reprocess"
        @click="form.action = 'REQUEST_REPROCESS'"
      >
        要求重处理
      </ElButton>
    </div>
    <label class="reason-label" for="quality-review-reason">审核原因</label>
    <ElInput
      id="quality-review-reason"
      v-model="form.reason"
      data-testid="quality-review-reason"
      type="textarea"
      :rows="4"
      maxlength="500"
      show-word-limit
      placeholder="写明核对依据或需要重处理的具体原因"
    />
    <ElAlert v-if="errorMessage" :title="errorMessage" type="error" :closable="false" show-icon />
    <template #footer>
      <ElButton :disabled="submitting" @click="emit('update:open', false)">取消</ElButton>
      <ElButton
        type="primary"
        data-testid="submit-quality-review"
        :loading="submitting"
        :disabled="!canSubmit"
        @click="submit"
      >
        提交审核
      </ElButton>
    </template>
  </ElDialog>
</template>

<style scoped>
.review-ledger {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 12px;
  padding: 12px 14px;
  border: 1px solid var(--line-strong);
  background: var(--ink-950);
  color: #fff;
}
.review-ledger span,
.review-ledger code {
  color: var(--accent-400);
  font-family: var(--font-mono);
  font-size: 9px;
}
.review-ledger strong {
  grid-row: 1 / 3;
  grid-column: 2;
  align-self: center;
  font-family: var(--font-editorial);
}
.action-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 18px 0;
}
.reason-label {
  display: block;
  margin-bottom: 7px;
  font-size: 11px;
  font-weight: 700;
}
.el-alert {
  margin-top: 12px;
}
</style>
