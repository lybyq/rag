<script setup lang="ts">
import type {
  KnowledgeSpace,
  KnowledgeSpacePolicyVersion,
  SpaceGrant,
  UpsertSpaceGrantRequest,
  SpaceManifest,
} from '@rag/contracts';
import GrantEditor from './GrantEditor.vue';
import GrantTable from './GrantTable.vue';
import PolicyTimeline from './PolicyTimeline.vue';

defineProps<{
  space?: KnowledgeSpace;
  grants: readonly SpaceGrant[];
  policyVersions: readonly KnowledgeSpacePolicyVersion[];
  manifests: readonly SpaceManifest[];
  submitting: boolean;
}>();

const emit = defineEmits<{
  close: [];
  grant: [request: UpsertSpaceGrantRequest];
  revoke: [grant: SpaceGrant];
}>();
</script>

<template>
  <aside v-if="space" class="access-drawer" aria-label="空间治理面板">
    <header>
      <div>
        <span>ACCESS GOVERNANCE · v{{ space.policyVersion }}</span>
        <h2>{{ space.name }}</h2>
        <p>{{ space.code }} · owner {{ space.ownerUserId }}</p>
      </div>
      <button type="button" aria-label="关闭治理面板" @click="emit('close')">×</button>
    </header>

    <ElTabs>
      <ElTabPane label="基本信息">
        <ElDescriptions :column="1" border>
          <ElDescriptionsItem label="描述">{{ space.description ?? '未填写' }}</ElDescriptionsItem>
          <ElDescriptionsItem label="状态">{{ space.status }}</ElDescriptionsItem>
          <ElDescriptionsItem label="文档量">{{ space.documentCount }}</ElDescriptionsItem>
          <ElDescriptionsItem label="我的权限">
            {{ space.effectivePermissions.join(', ') }}
          </ElDescriptionsItem>
        </ElDescriptions>
      </ElTabPane>
      <ElTabPane label="授权治理">
        <template v-if="space.effectivePermissions.includes('ADMIN')">
          <GrantEditor :submitting="submitting" @submit="emit('grant', $event)" />
          <section class="drawer-section">
            <h3>当前授权</h3>
            <GrantTable :items="grants" :submitting="submitting" @revoke="emit('revoke', $event)" />
          </section>
        </template>
        <ElAlert v-else title="你拥有读取权限，但没有空间治理权限" type="info" :closable="false" />
      </ElTabPane>
      <ElTabPane label="质量策略">
        <ElAlert
          title="质量规则由启动时锁定的 Quality Profile 执行；每个版本的自动裁决、人工审核和重处理原因保存在文档质量报告中。"
          type="info"
          :closable="false"
        />
        <p class="policy-fact">
          空间策略版本 <strong>v{{ space.policyVersion }}</strong
          >；发布只接纳质量门禁通过或已授权审核的内容修订。
        </p>
      </ElTabPane>
      <ElTabPane label="检索 Profile / 版本">
        <ElTable :data="[...manifests]" empty-text="空间尚未发布 Manifest">
          <ElTableColumn prop="version" label="版本" width="70" /><ElTableColumn
            prop="status"
            label="状态"
            width="100"
          /><ElTableColumn
            prop="embeddingProfileId"
            label="Embedding Profile"
            min-width="180"
          /><ElTableColumn
            prop="embeddingModelRevision"
            label="Revision"
            min-width="120"
          /><ElTableColumn prop="expectedVectorCount" label="向量" width="90" />
        </ElTable>
      </ElTabPane>
      <ElTabPane label="策略历史"><PolicyTimeline :items="policyVersions" /></ElTabPane>
    </ElTabs>
  </aside>
</template>

<style scoped>
.access-drawer {
  min-width: 0;
  padding: 22px;
  background: var(--surface-elevated);
  border-left: 1px solid var(--line-strong);
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line-subtle);
}
header span {
  color: var(--accent-600);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
}
h2 {
  margin: 8px 0 4px;
  font-family: var(--font-editorial);
  font-size: 21px;
}
header p {
  margin: 0;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
header button {
  padding: 0 4px;
  color: var(--text-secondary);
  font-size: 24px;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.grant-editor {
  margin-top: 18px;
}
.drawer-section {
  margin-top: 24px;
}
.drawer-section h3 {
  margin: 0;
  font-size: 12px;
}
</style>
