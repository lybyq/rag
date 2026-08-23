/**
 * Element Plus X 的 Vitest 边界替身。
 *
 * 生产构建仍解析真实的固定版本依赖；单元测试只关心项目 Adapter 对外的 props、事件与插槽，
 * 因此这里隔离上游包的 CSS 副作用。业务测试不得直接引用本文件。
 *
 * @requirement WEB-004
 */
/* eslint-disable vue/one-component-per-file */
import { defineComponent, h } from 'vue';

/** 测试态会话列表替身。 */
export const Conversations = defineComponent({
  name: 'StubConversations',
  props: { items: { type: Array, default: () => [] } },
  setup:
    (_props, { slots }) =>
    () =>
      h('div', slots.default?.()),
});

/** 测试态消息气泡列表替身。 */
export const BubbleList = defineComponent({
  name: 'BubbleList',
  props: { list: { type: Array, default: () => [] } },
  setup:
    (props, { slots }) =>
    () =>
      h(
        'div',
        (props.list as readonly unknown[]).map((item) => slots.content?.({ item })),
      ),
});

/** 测试态输入框替身；具体提交行为由用例中的局部 Stub 覆盖。 */
export const XSender = defineComponent({
  name: 'XSender',
  setup: () => () => h('div'),
});

/** 测试态思考阶段替身。 */
export const Thinking = defineComponent({
  name: 'StubThinking',
  setup:
    (_props, { slots }) =>
    () =>
      h('div', slots.default?.()),
});
