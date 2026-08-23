<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import DevelopmentIdentityPanel from '@/features/identity/components/DevelopmentIdentityPanel.vue';
import ProviderSettingsPanel from '@/features/operations/components/ProviderSettingsPanel.vue';
</script>

<template>
  <div class="settings-view">
    <PageHeader
      eyebrow="身份权限与知识空间 · IDENTITY ADAPTER"
      title="身份与接入"
      description="查看服务端解析后的 userId、系统语义角色和授权版本；开发环境可切换预置身份验证权限边界。"
    />
    <DevelopmentIdentityPanel />
    <ProviderSettingsPanel />
  </div>
</template>

<style scoped>
.settings-view {
  max-width: 1500px;
  margin: 0 auto;
  display: grid;
  gap: 24px;
}
</style>
