<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue';
import DocumentIngestionWorkbench from '@/features/document-ingestion/components/DocumentIngestionWorkbench.vue';
</script>

<template>
  <div>
    <PageHeader
      eyebrow="M02 · DOCUMENT INGESTION"
      title="文档接入与任务中心"
      description="批量文件通过短时预签名 URL 直达对象存储；完成后以事务写入文档、版本、任务与 Outbox，并展示可恢复的真实步骤进度。"
    />
    <DocumentIngestionWorkbench />
  </div>
</template>
