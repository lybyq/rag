import PlatformOverviewView from '@/views/PlatformOverviewView.vue';
import type { Component } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

const KnowledgeSpacesView = (): Promise<{ default: Component }> =>
  import('@/views/KnowledgeSpacesView.vue');
const DocumentIngestionView = (): Promise<{ default: Component }> =>
  import('@/views/DocumentIngestionView.vue');
const SettingsView = (): Promise<{ default: Component }> => import('@/views/SettingsView.vue');
const AssistantView = (): Promise<{ default: Component }> => import('@/views/AssistantView.vue');
const EvaluationView = (): Promise<{ default: Component }> => import('@/views/EvaluationView.vue');
const OperationsView = (): Promise<{ default: Component }> => import('@/views/OperationsView.vue');
const AuditView = (): Promise<{ default: Component }> => import('@/views/AuditView.vue');
const RetrievalLabView = (): Promise<{ default: Component }> =>
  import('@/views/RetrievalLabView.vue');
const QualityReviewView = (): Promise<{ default: Component }> =>
  import('@/views/QualityReviewView.vue');

/** 路由 meta 作为导航和页面说明的单一来源。 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: PlatformOverviewView, meta: { title: '运营总览' } },
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
      component: AssistantView,
      meta: { title: '知识问答', module: '会话运行与事件～证据与答案生成' },
    },
    {
      path: '/reviews',
      name: 'reviews',
      component: QualityReviewView,
      meta: { title: '知识审核台', module: '知识加工、质量与审核' },
    },
    {
      path: '/evaluation',
      name: 'evaluation',
      component: EvaluationView,
      meta: { title: '评测与观测', module: '评测与可靠性' },
    },
    {
      path: '/retrieval-lab',
      name: 'retrieval-lab',
      component: RetrievalLabView,
      meta: { title: '检索测试台', module: 'Query Plan 与混合检索' },
    },
    {
      path: '/operations',
      name: 'operations',
      component: OperationsView,
      meta: { title: '运行健康与告警', module: '评测与生产可靠性' },
    },
    {
      path: '/audit',
      name: 'audit',
      component: AuditView,
      meta: { title: '审计检索与导出', module: '评测与生产可靠性' },
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
