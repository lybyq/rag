/** 当前身份跨 AppShell 和设置页共享，因此使用 Pinia setup store。 */
import {
  DevelopmentIdentityPresetListEnvelopeSchema,
  UserContextEnvelopeSchema,
  type DevelopmentIdentityPreset,
  type IdentitySession,
} from '@rag/contracts';
import { defineStore } from 'pinia';
import { computed, shallowRef } from 'vue';
import {
  getSelectedDevelopmentPreset,
  platformApiFetch,
  setSelectedDevelopmentPreset,
} from '../services/platformApi';

export const useIdentityStore = defineStore('identity', () => {
  const session = shallowRef<IdentitySession>();
  const presets = shallowRef<readonly DevelopmentIdentityPreset[]>([]);
  const defaultPresetId = shallowRef('');
  const loading = shallowRef(false);
  const initialized = shallowRef(false);
  const errorMessage = shallowRef('');
  const isDevelopmentMock = computed(
    () => session.value?.authMode === 'mock' && session.value.appEnv !== 'production',
  );
  const selectedPresetId = computed(() => getSelectedDevelopmentPreset() ?? defaultPresetId.value);

  /** 首次进入时并行意图被拆成有序调用：先知道默认 preset，再读取当前身份。 */
  async function initialize(force = false): Promise<void> {
    if (loading.value || (initialized.value && !force)) return;
    loading.value = true;
    errorMessage.value = '';
    try {
      try {
        const presetEnvelope = await platformApiFetch(
          '/api/v1/auth/dev/presets',
          DevelopmentIdentityPresetListEnvelopeSchema,
        );
        presets.value = presetEnvelope.data.items;
        defaultPresetId.value = presetEnvelope.data.defaultPresetId;
      } catch {
        presets.value = [];
      }
      const sessionEnvelope = await platformApiFetch('/api/v1/auth/me', UserContextEnvelopeSchema);
      session.value = sessionEnvelope.data;
      initialized.value = true;
    } catch (error: unknown) {
      errorMessage.value = error instanceof Error ? error.message : '身份读取失败';
    } finally {
      loading.value = false;
    }
  }

  /** 切换后立即重新向服务端认证，页面从不本地伪造新角色。 */
  async function selectPreset(presetId: string): Promise<void> {
    if (!presets.value.some((preset) => preset.presetId === presetId)) {
      throw new Error('只能选择服务端返回的身份预置');
    }
    setSelectedDevelopmentPreset(presetId);
    await initialize(true);
  }

  return {
    session,
    presets,
    loading,
    initialized,
    errorMessage,
    isDevelopmentMock,
    selectedPresetId,
    initialize,
    selectPreset,
  };
});
