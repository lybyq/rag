<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import KnowledgeSpaceWorkbench from '@/features/knowledge-spaces/components/KnowledgeSpaceWorkbench.vue';
</script>

<template>
  <div>
    <PageHeader
      eyebrow="M01 · KNOWLEDGE GOVERNANCE"
      title="知识空间"
      description="以空间为最小治理边界，统一管理负责人、用户/角色 ACL、停用状态与不可变策略版本。"
    />
    <KnowledgeSpaceWorkbench />
  </div>
</template>
