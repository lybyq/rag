<!-- Provider/Profile 健康和 Feature Flag 灰度；不显示密钥。 @requirement WEB-024 WEB-030 OPT-018 -->
<script setup lang="ts">
/* eslint-disable vue/multiline-html-element-content-newline -- 表格与表单模板遵循 Prettier。 */
import { reactive, ref, shallowRef } from 'vue';
import type { FeatureFlag } from '@rag/contracts';
import { useProviderSettings } from '../composables/useOperationsConsole';
const state = useProviderSettings();
const dialogOpen = ref(false);
const selected = shallowRef<FeatureFlag>();
const form = reactive({ enabled: false, rolloutPercent: 100, reason: '' });
function edit(flag: FeatureFlag): void {
  selected.value = flag;
  form.enabled = flag.enabled;
  form.rolloutPercent = flag.rolloutPercent;
  form.reason = '';
  dialogOpen.value = true;
}
async function save(): Promise<void> {
  if (!selected.value || form.reason.trim().length < 2) return;
  await state.update(selected.value, form.enabled, form.rolloutPercent, form.reason);
  dialogOpen.value = false;
}
</script>

<template>
  <section class="provider-settings">
    <ElAlert
      v-if="state.errorMessage.value"
      :title="state.errorMessage.value"
      type="error"
      :closable="false"
    >
      <template #default><ElButton text @click="state.load">重试</ElButton></template>
    </ElAlert>
    <header>
      <div>
        <span>INTRANET PROVIDERS</span>
        <h2>能力配置与兼容性</h2>
      </div>
      <small>密钥仅显示“已配置/未配置”</small>
    </header>
    <ElTable
      v-loading="state.loading.value"
      :data="[...state.providers.value]"
      empty-text="当前角色不可见或尚无 Provider"
    >
      <ElTableColumn prop="capability" label="能力" width="130" /><ElTableColumn
        prop="adapter"
        label="Adapter"
        min-width="140"
      /><ElTableColumn prop="profileId" label="Profile" min-width="190" /><ElTableColumn
        prop="modelId"
        label="模型"
        min-width="150"
      /><ElTableColumn prop="revision" label="Revision" min-width="130" /><ElTableColumn
        prop="endpointHost"
        label="Endpoint Host"
        min-width="170"
      />
      <ElTableColumn label="凭据" width="100">
        <template #default="{ row }">
          <ElTag :type="row.credentialConfigured ? 'success' : 'info'" effect="plain">
            {{ row.credentialConfigured ? '已配置' : '未配置' }}
          </ElTag>
        </template>
      </ElTableColumn>
      <ElTableColumn prop="compatibilityMessage" label="兼容性" min-width="220" />
    </ElTable>
    <header class="flag-heading">
      <div>
        <span>CONTROLLED ROLLOUT</span>
        <h2>Feature Flags</h2>
      </div>
    </header>
    <ElAlert
      title="这里显示的是数据库中的实际运行开关；env 只在首次建表时提供默认值，修改 env 不会覆盖已有记录。新建 Run 会冻结当时的开关决定，进行中的 Run 不变。"
      type="info"
      :closable="false"
      show-icon
    />
    <ElTable :data="[...state.flags.value]" empty-text="没有 Feature Flag">
      <ElTableColumn prop="key" label="Flag" min-width="250" /><ElTableColumn
        prop="scope"
        label="范围"
        width="100"
      /><ElTableColumn label="启用" width="90">
        <template #default="{ row }">
          <ElTag :type="row.enabled ? 'success' : 'info'" effect="plain">
            {{ row.enabled ? 'ON' : 'OFF' }}
          </ElTag>
        </template> </ElTableColumn
      ><ElTableColumn prop="rolloutPercent" label="灰度(%)" width="100" /><ElTableColumn
        prop="version"
        label="版本"
        width="80"
      /><ElTableColumn prop="reason" label="原因" min-width="220" /><ElTableColumn
        label="操作"
        width="90"
      >
        <template #default="{ row }">
          <ElButton text type="primary" @click="edit(row)">调整</ElButton>
        </template>
      </ElTableColumn>
    </ElTable>
    <ElDialog v-model="dialogOpen" title="调整 Feature Flag" width="460px">
      <ElForm label-position="top">
        <ElFormItem label="启用"><ElSwitch v-model="form.enabled" /></ElFormItem
        ><ElFormItem label="稳定灰度比例">
          <ElSlider v-model="form.rolloutPercent" show-input /> </ElFormItem
        ><ElFormItem label="变更原因（写入审计）">
          <ElInput v-model="form.reason" type="textarea" :rows="3" />
        </ElFormItem>
      </ElForm>
      <template #footer>
        <ElButton @click="dialogOpen = false">取消</ElButton
        ><ElButton type="primary" :disabled="form.reason.trim().length < 2" @click="save">
          带乐观锁保存
        </ElButton>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.provider-settings {
  display: grid;
  gap: 16px;
}
.provider-settings > header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  margin-top: 8px;
}
.provider-settings header span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
}
.provider-settings h2 {
  margin: 5px 0 0;
  font-family: var(--font-editorial);
}
.provider-settings header > small {
  color: var(--text-tertiary);
}
.flag-heading {
  margin-top: 26px !important;
}
</style>
