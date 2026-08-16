<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import DevelopmentIdentityPanel from '@/features/identity/components/DevelopmentIdentityPanel.vue';
</script>

<template>
  <div>
    <PageHeader
      eyebrow="M01 · IDENTITY ADAPTER"
      title="身份与接入"
      description="查看服务端解析后的 userId、系统语义角色和授权版本；开发环境可切换预置身份验证权限边界。"
    />
    <DevelopmentIdentityPanel />
  </div>
</template>
