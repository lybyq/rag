import FoundationOverviewView from '@/views/FoundationOverviewView.vue';
import type { Component } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

const KnowledgeSpacesView = (): Promise<{ default: Component }> =>
  import('@/views/KnowledgeSpacesView.vue');
const PlaceholderView = (): Promise<{ default: Component }> =>
  import('@/views/PlaceholderView.vue');
const DocumentIngestionView = (): Promise<{ default: Component }> =>
  import('@/views/DocumentIngestionView.vue');
const SettingsView = (): Promise<{ default: Component }> => import('@/views/SettingsView.vue');

/** 路由 meta 作为导航和页面说明的单一来源。 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: FoundationOverviewView, meta: { title: '工程总览' } },
    {
      path: '/knowledge',
      name: 'knowledge',
      component: KnowledgeSpacesView,
      meta: { title: '知识空间', module: '身份权限与知识空间～索引构建与发布' },
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: DocumentIngestionView,
      meta: { title: '任务中心', module: '文档接入与任务～索引构建与发布' },
    },
    {
      path: '/assistant',
      name: 'assistant',
      component: PlaceholderView,
      meta: { title: '知识问答', module: '会话运行与事件～证据与答案生成' },
    },
    {
      path: '/evaluation',
      name: 'evaluation',
      component: PlaceholderView,
      meta: { title: '评测与观测', module: '评测与可靠性' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: SettingsView,
      meta: { title: '平台设置', module: '身份权限与知识空间、评测与可靠性' },
    },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
