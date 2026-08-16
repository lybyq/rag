/** 知识空间页面的 API 状态和命令编排。 */
import {
  KnowledgeSpaceEnvelopeSchema,
  KnowledgeSpaceListEnvelopeSchema,
  PolicyVersionListEnvelopeSchema,
  SpaceGrantListEnvelopeSchema,
  SpaceGrantSchema,
  type CreateKnowledgeSpaceRequest,
  type KnowledgeSpace,
  type KnowledgeSpacePolicyVersion,
  type KnowledgeSpaceStatus,
  type RevokeSpaceGrantRequest,
  type SpaceGrant,
  type UpdateKnowledgeSpaceRequest,
  type UpsertSpaceGrantRequest,
} from '@rag/contracts';
import { computed, onMounted, reactive, shallowRef, type ComputedRef, type ShallowRef } from 'vue';
import { z } from 'zod';
import { platformApiFetch } from '../../identity/services/platformApi';
import { useIdentityStore } from '../../identity/stores/useIdentityStore';

export interface KnowledgeSpaceFilters {
  search: string;
  status: '' | KnowledgeSpaceStatus;
}

export interface KnowledgeSpacesComposable {
  spaces: ShallowRef<readonly KnowledgeSpace[]>;
  selectedSpace: ShallowRef<KnowledgeSpace | undefined>;
  grants: ShallowRef<readonly SpaceGrant[]>;
  policyVersions: ShallowRef<readonly KnowledgeSpacePolicyVersion[]>;
  filters: KnowledgeSpaceFilters;
  loading: ShallowRef<boolean>;
  mutating: ShallowRef<boolean>;
  errorMessage: ShallowRef<string>;
  canCreate: ComputedRef<boolean>;
  loadSpaces: () => Promise<void>;
  selectSpace: (space: KnowledgeSpace) => Promise<void>;
  createSpace: (request: CreateKnowledgeSpaceRequest) => Promise<void>;
  updateSpace: (spaceId: string, request: UpdateKnowledgeSpaceRequest) => Promise<void>;
  deactivateSpace: (space: KnowledgeSpace, reason: string) => Promise<void>;
  upsertGrant: (spaceId: string, request: UpsertSpaceGrantRequest) => Promise<void>;
  revokeGrant: (
    spaceId: string,
    grantId: string,
    request: RevokeSpaceGrantRequest,
  ) => Promise<void>;
}

export function useKnowledgeSpaces(): KnowledgeSpacesComposable {
  const identity = useIdentityStore();
  const spaces = shallowRef<readonly KnowledgeSpace[]>([]);
  const selectedSpace = shallowRef<KnowledgeSpace>();
  const grants = shallowRef<readonly SpaceGrant[]>([]);
  const policyVersions = shallowRef<readonly KnowledgeSpacePolicyVersion[]>([]);
  const filters = reactive<KnowledgeSpaceFilters>({ search: '', status: '' });
  const loading = shallowRef(false);
  const mutating = shallowRef(false);
  const errorMessage = shallowRef('');
  const canCreate = computed(() =>
    Boolean(
      identity.session?.user.roles.some((role) =>
        ['KNOWLEDGE_EDITOR', 'KNOWLEDGE_ADMIN', 'SYSTEM_ADMIN'].includes(role),
      ),
    ),
  );

  async function loadSpaces(): Promise<void> {
    loading.value = true;
    errorMessage.value = '';
    try {
      const query = new URLSearchParams();
      if (filters.search.trim()) query.set('search', filters.search.trim());
      if (filters.status) query.set('status', filters.status);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      const response = await platformApiFetch(
        `/api/v1/spaces${suffix}`,
        KnowledgeSpaceListEnvelopeSchema,
      );
      spaces.value = response.data.items;
      if (selectedSpace.value) {
        selectedSpace.value = spaces.value.find((item) => item.id === selectedSpace.value?.id);
      }
    } catch (error: unknown) {
      errorMessage.value = error instanceof Error ? error.message : '知识空间加载失败';
    } finally {
      loading.value = false;
    }
  }

  async function loadGovernance(spaceId: string): Promise<void> {
    const [grantResponse, versionResponse] = await Promise.all([
      platformApiFetch(`/api/v1/spaces/${spaceId}/grants`, SpaceGrantListEnvelopeSchema),
      platformApiFetch(
        `/api/v1/spaces/${spaceId}/policy-versions`,
        PolicyVersionListEnvelopeSchema,
      ),
    ]);
    grants.value = grantResponse.data.items;
    policyVersions.value = versionResponse.data.items;
  }

  async function selectSpace(space: KnowledgeSpace): Promise<void> {
    selectedSpace.value = space;
    if (space.effectivePermissions.includes('ADMIN')) await loadGovernance(space.id);
    else {
      grants.value = [];
      policyVersions.value = [];
    }
  }

  async function runMutation(command: () => Promise<void>): Promise<void> {
    mutating.value = true;
    errorMessage.value = '';
    try {
      await command();
    } catch (error: unknown) {
      errorMessage.value = error instanceof Error ? error.message : '操作失败';
      throw error;
    } finally {
      mutating.value = false;
    }
  }

  async function createSpace(request: CreateKnowledgeSpaceRequest): Promise<void> {
    await runMutation(async () => {
      await platformApiFetch('/api/v1/spaces', KnowledgeSpaceEnvelopeSchema, {
        method: 'POST',
        body: JSON.stringify(request),
      });
      await loadSpaces();
    });
  }

  async function updateSpace(spaceId: string, request: UpdateKnowledgeSpaceRequest): Promise<void> {
    await runMutation(async () => {
      await platformApiFetch(`/api/v1/spaces/${spaceId}`, KnowledgeSpaceEnvelopeSchema, {
        method: 'PATCH',
        body: JSON.stringify(request),
      });
      await loadSpaces();
    });
  }

  async function deactivateSpace(space: KnowledgeSpace, reason: string): Promise<void> {
    await runMutation(async () => {
      await platformApiFetch(
        `/api/v1/spaces/${space.id}/deactivate`,
        KnowledgeSpaceEnvelopeSchema,
        {
          method: 'POST',
          body: JSON.stringify({ expectedVersion: space.version, reason }),
        },
      );
      await loadSpaces();
    });
  }

  async function upsertGrant(spaceId: string, request: UpsertSpaceGrantRequest): Promise<void> {
    await runMutation(async () => {
      await platformApiFetch(
        `/api/v1/spaces/${spaceId}/grants`,
        z.object({ requestId: z.string(), data: SpaceGrantSchema }),
        { method: 'PUT', body: JSON.stringify(request) },
      );
      await Promise.all([loadGovernance(spaceId), loadSpaces()]);
    });
  }

  async function revokeGrant(
    spaceId: string,
    grantId: string,
    request: RevokeSpaceGrantRequest,
  ): Promise<void> {
    await runMutation(async () => {
      await platformApiFetch(
        `/api/v1/spaces/${spaceId}/grants/${grantId}`,
        z.object({ requestId: z.string(), data: z.object({ revoked: z.literal(true) }) }),
        { method: 'DELETE', body: JSON.stringify(request) },
      );
      await Promise.all([loadGovernance(spaceId), loadSpaces()]);
    });
  }

  onMounted(() => {
    void identity.initialize();
    void loadSpaces();
  });
  return {
    spaces,
    selectedSpace,
    grants,
    policyVersions,
    filters,
    loading,
    mutating,
    errorMessage,
    canCreate,
    loadSpaces,
    selectSpace,
    createSpace,
    updateSpace,
    deactivateSpace,
    upsertGrant,
    revokeGrant,
  };
}
