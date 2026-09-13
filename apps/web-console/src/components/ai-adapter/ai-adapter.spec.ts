/**
 * Element Plus X 适配层契约测试：固定版本、Sender 输出和引用事件均由项目 API 隔离。
 * 上游组件属性或 expose 发生 breaking change 时，本测试会在业务页面之前失败。
 *
 * @requirement WEB-004
 * @requirement WEB-020
 * @requirement WEB-021
 */
/* eslint-disable vue/one-component-per-file */
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { describe, expect, it } from 'vitest';
import webPackage from '../../../package.json';
import AiMessageList from './AiMessageList.vue';
import AiSender from './AiSender.vue';
import AiThinkingStatus from './AiThinkingStatus.vue';

const XSenderStub = defineComponent({
  name: 'XSender',
  emits: ['submit', 'cancel'],
  setup(_props, { emit, expose }) {
    expose({
      getModelValue: () => ({ text: '如何办理企业审批？' }),
      clear: () => undefined,
      focus: () => undefined,
    });
    return () =>
      h('button', { 'data-test': 'third-party-submit', onClick: () => emit('submit') }, 'send');
  },
});

const BubbleListStub = defineComponent({
  name: 'BubbleList',
  props: { list: { type: Array, required: true } },
  setup(props, { slots }) {
    return () =>
      h(
        'div',
        props.list.map((item) => slots.content?.({ item })),
      );
  },
});

const ThinkingStub = defineComponent({
  name: 'ThinkingStub',
  setup:
    (_props, { slots }) =>
    () =>
      h('section', [slots.label?.(), slots.content?.()]),
});

const AlertStub = defineComponent({
  name: 'ElAlert',
  props: { title: { type: String, required: true } },
  setup: (props) => () => h('div', { role: 'alert' }, props.title),
});

describe('AI Adapter', () => {
  it('WEB-004 固定 Element Plus X 精确版本，禁止范围升级', () => {
    expect(webPackage.dependencies['vue-element-plus-x']).toBe('2.0.3');
  });

  it('WEB-004 XSender 的第三方提交事件被转换成项目 submit(value)', async () => {
    const wrapper = mount(AiSender, { global: { stubs: { XSender: XSenderStub } } });
    await wrapper.get('[data-test="third-party-submit"]').trigger('click');
    expect(wrapper.emitted('submit')).toEqual([['如何办理企业审批？']]);
  });

  it('WEB-020/021 Markdown 禁止原始 HTML，Claim 引用转换为可点击项目事件', async () => {
    const citationId = '018f6c1a-5412-7cc0-b242-92aa0f56f902';
    const wrapper = mount(AiMessageList, {
      props: {
        items: [
          {
            id: '018f6c1a-5412-7cc0-b242-92aa0f56f901',
            conversationId: '018f6c1a-5412-7cc0-b242-92aa0f56f903',
            runId: null,
            role: 'ASSISTANT',
            status: 'VISIBLE',
            content: `结论 [${citationId}] <script>bad()</script>`,
            contentStoredAs: 'PLAIN',
            contentSha256: 'a'.repeat(64),
            citationsSummary: null,
            createdAt: '2026-08-23T00:00:00.000Z',
          },
        ],
      },
      global: { stubs: { BubbleList: BubbleListStub } },
    });
    expect(wrapper.html()).not.toContain('<script>');
    await wrapper.get('[data-citation-id]').trigger('click');
    expect(wrapper.emitted('citation')).toEqual([[citationId]]);
  });

  it('OPT-011 展示后端真实时间线、实际耗时和慢请求取消提示', () => {
    const wrapper = mount(AiThinkingStatus, {
      props: {
        stage: '已保留 4 条证据，正在根据资料整理答案。',
        state: 'running',
        timeline: [
          {
            sequence: 8,
            status: 'COMPLETED',
            message: '已找到 2 份可访问的相关资料，正在筛选。',
            occurredAt: '2026-09-13T01:02:03.000Z',
            durationMs: 438,
          },
          {
            sequence: 9,
            status: 'RUNNING',
            message: '正在根据已保留资料整理答案。',
            occurredAt: '2026-09-13T01:02:04.000Z',
          },
        ],
        elapsedSeconds: 13,
        slowNotice: true,
      },
      global: { stubs: { StubThinking: ThinkingStub, ElAlert: AlertStub } },
    });

    expect(wrapper.get('[aria-label="真实处理说明时间线"]').text()).toContain('已等待 13 秒');
    expect(wrapper.text()).toContain('已找到 2 份可访问的相关资料');
    expect(wrapper.text()).toContain('本次等待较久，你可以取消运行');
    expect(wrapper.text()).not.toContain('answer_expand_evidence');
  });
});
