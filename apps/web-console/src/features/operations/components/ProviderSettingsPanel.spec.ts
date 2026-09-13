/**
 * Provider 与 Feature Flag 设置页的运行事实提示测试。
 *
 * @requirement OPT-005
 */
import { shallowMount } from '@vue/test-utils';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import ProviderSettingsPanel from './ProviderSettingsPanel.vue';

vi.mock('../composables/useOperationsConsole', () => ({
  useProviderSettings: () => ({
    errorMessage: ref(''),
    loading: ref(false),
    providers: ref([]),
    flags: ref([]),
    load: vi.fn(),
    update: vi.fn(),
  }),
}));

describe('[OPT-005] ProviderSettingsPanel effective flag notice', () => {
  it('明确区分数据库运行开关、env 初始默认值和在途 Run 快照', () => {
    const wrapper = shallowMount(ProviderSettingsPanel);
    const notices = wrapper.findAll('el-alert-stub').map((alert) => alert.attributes('title'));

    expect(notices).toContain(
      '这里显示的是数据库中的实际运行开关；env 只在首次建表时提供默认值，修改 env 不会覆盖已有记录。新建 Run 会冻结当时的开关决定，进行中的 Run 不变。',
    );
  });
});
