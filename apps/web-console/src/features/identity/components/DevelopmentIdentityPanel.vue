<script setup lang="ts">
import { ElMessage } from 'element-plus/es';
import { storeToRefs } from 'pinia';
import { onMounted } from 'vue';
import { useIdentityStore } from '../stores/useIdentityStore';

const identity = useIdentityStore();
const { session, presets, loading, errorMessage, isDevelopmentMock, selectedPresetId } =
  storeToRefs(identity);

onMounted(() => void identity.initialize());

async function selectPreset(presetId: string): Promise<void> {
  await identity.selectPreset(presetId);
  ElMessage.success('开发身份已由服务端重新解析');
}
</script>

<template>
  <section class="identity-panel">
    <header>
      <span>AUTH ADAPTER</span>
      <h2>当前身份边界</h2>
      <p>浏览器只选择 presetId；userId、roles 和 authzVersion 均由服务端建立。</p>
    </header>

    <ElSkeleton v-if="loading && !session" :rows="4" animated />
    <ElAlert v-else-if="errorMessage" :title="errorMessage" type="error" :closable="false" />
    <template v-else-if="session">
      <div class="identity-facts">
        <div>
          <span>USER ID</span><strong>{{ session.user.userId }}</strong>
        </div>
        <div>
          <span>AUTH MODE</span><strong>{{ session.authMode }}</strong>
        </div>
        <div>
          <span>AUTHZ VERSION</span><strong>v{{ session.user.authzVersion }}</strong>
        </div>
        <div>
          <span>RESOLVED AT</span><strong>{{ session.user.resolvedAt }}</strong>
        </div>
      </div>
      <div class="role-line">
        <span v-for="role in session.user.roles" :key="role">{{ role }}</span>
        <em v-if="session.user.roles.length === 0">无已映射角色（默认无权限）</em>
      </div>

      <div v-if="isDevelopmentMock" class="presets">
        <button
          v-for="preset in presets"
          :key="preset.presetId"
          type="button"
          :class="{ selected: preset.presetId === selectedPresetId }"
          @click="selectPreset(preset.presetId)"
        >
          <span>{{ preset.label }}</span>
          <strong>{{ preset.userId }}</strong>
          <small>{{ preset.roles.join(' · ') || '无映射角色' }}</small>
        </button>
      </div>
      <ElAlert
        v-else
        title="当前使用内网认证模式，生产界面不会显示 Mock 身份入口。"
        type="info"
        :closable="false"
      />
    </template>
  </section>
</template>

<style scoped>
.identity-panel {
  max-width: 980px;
  margin-top: 26px;
  padding: 28px;
  background: var(--surface-elevated);
  border: 1px solid var(--line-strong);
}
header span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.14em;
}
h2 {
  margin: 8px 0;
  font-family: var(--font-editorial);
  font-size: 26px;
}
header p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
}
.identity-facts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 26px;
  border: 1px solid var(--line-subtle);
}
.identity-facts div {
  min-width: 0;
  padding: 16px;
  border-right: 1px solid var(--line-subtle);
}
.identity-facts div:last-child {
  border-right: 0;
}
.identity-facts span,
.identity-facts strong {
  display: block;
}
.identity-facts span {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 8px;
}
.identity-facts strong {
  margin-top: 8px;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
}
.role-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 14px 0 24px;
}
.role-line span {
  padding: 4px 7px;
  color: var(--accent-700);
  font-family: var(--font-mono);
  font-size: 9px;
  background: var(--accent-050);
  border: 1px solid var(--accent-200);
}
.role-line em {
  color: var(--text-tertiary);
  font-size: 11px;
}
.presets {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.presets button {
  padding: 16px;
  text-align: left;
  color: inherit;
  border: 1px solid var(--line-subtle);
  background: #f5f2eb;
  cursor: pointer;
}
.presets button.selected {
  border-color: var(--accent-500);
  box-shadow: inset 3px 0 var(--accent-500);
}
.presets span,
.presets strong,
.presets small {
  display: block;
}
.presets span {
  font-size: 13px;
  font-weight: 650;
}
.presets strong,
.presets small {
  margin-top: 6px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
@media (max-width: 760px) {
  .identity-facts,
  .presets {
    grid-template-columns: 1fr;
  }
  .identity-facts div {
    border-right: 0;
    border-bottom: 1px solid var(--line-subtle);
  }
}
</style>
