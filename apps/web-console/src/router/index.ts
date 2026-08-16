import FoundationOverviewView from '@/views/FoundationOverviewView.vue';
import type { Component } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

const KnowledgeSpacesView = (): Promise<{ default: Component }> =>
  import('@/views/KnowledgeSpacesView.vue');
const PlaceholderView = (): Promise<{ default: Component }> =>
  import('@/views/PlaceholderView.vue');
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
      meta: { title: '知识空间', module: 'M01～M05' },
    },
    {
      path: '/tasks',
      name: 'tasks',
      component: PlaceholderView,
      meta: { title: '任务中心', module: 'M02～M05' },
    },
    {
      path: '/assistant',
      name: 'assistant',
      component: PlaceholderView,
      meta: { title: '知识问答', module: 'M06～M08' },
    },
    {
      path: '/evaluation',
      name: 'evaluation',
      component: PlaceholderView,
      meta: { title: '评测与观测', module: 'M09' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: SettingsView,
      meta: { title: '平台设置', module: 'M01、M09' },
    },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
