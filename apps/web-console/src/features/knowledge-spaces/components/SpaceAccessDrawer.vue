<script setup lang="ts">
import type {
  KnowledgeSpace,
  KnowledgeSpacePolicyVersion,
  SpaceGrant,
  UpsertSpaceGrantRequest,
} from '@rag/contracts';
import GrantEditor from './GrantEditor.vue';
import GrantTable from './GrantTable.vue';
import PolicyTimeline from './PolicyTimeline.vue';

defineProps<{
  space?: KnowledgeSpace;
  grants: readonly SpaceGrant[];
  policyVersions: readonly KnowledgeSpacePolicyVersion[];
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

    <template v-if="space.effectivePermissions.includes('ADMIN')">
      <GrantEditor :submitting="submitting" @submit="emit('grant', $event)" />
      <section class="drawer-section">
        <h3>当前授权</h3>
        <GrantTable :items="grants" :submitting="submitting" @revoke="emit('revoke', $event)" />
      </section>
      <section class="drawer-section">
        <h3>策略版本历史</h3>
        <PolicyTimeline :items="policyVersions" />
      </section>
    </template>
    <ElAlert v-else title="你拥有读取权限，但没有空间治理权限" type="info" :closable="false" />
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
