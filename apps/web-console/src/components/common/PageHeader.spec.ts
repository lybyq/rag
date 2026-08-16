import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PageHeader from './PageHeader.vue';

describe('PageHeader', () => {
  it('展示标题、阶段和说明', () => {
    const wrapper = mount(PageHeader, {
      props: { eyebrow: 'M00', title: '工程基线', description: '可重复开发环境' },
    });

    expect(wrapper.get('h1').text()).toBe('工程基线');
    expect(wrapper.text()).toContain('M00');
    expect(wrapper.text()).toContain('可重复开发环境');
  });
});
