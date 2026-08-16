<script setup lang="ts">
import { computed, shallowRef } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';

interface NavigationItem {
  label: string;
  caption: string;
  path: string;
  mark: string;
}

const route = useRoute();
const mobileNavigationOpen = shallowRef(false);
const navigation: readonly NavigationItem[] = [
  { label: '工程总览', caption: 'FOUNDATION', path: '/', mark: '01' },
  { label: '知识空间', caption: 'KNOWLEDGE', path: '/knowledge', mark: '02' },
  { label: '任务中心', caption: 'PIPELINE', path: '/tasks', mark: '03' },
  { label: '知识问答', caption: 'ASSISTANT', path: '/assistant', mark: '04' },
  { label: '评测观测', caption: 'OPERATIONS', path: '/evaluation', mark: '05' },
];
const currentTitle = computed(() => String(route.meta.title ?? 'RAG Console'));

/** 移动端完成导航后立即收起侧栏，避免遮挡新页面。 */
function closeMobileNavigation(): void {
  mobileNavigationOpen.value = false;
}
</script>

<template>
  <div class="app-shell">
    <aside class="side-rail" :class="{ 'is-open': mobileNavigationOpen }">
      <div class="brand-lockup">
        <span class="brand-seal">知</span>
        <div>
          <strong>知序</strong>
          <small>RAG CONTROL PLANE</small>
        </div>
      </div>

      <nav class="primary-navigation" aria-label="主导航">
        <RouterLink
          v-for="item in navigation"
          :key="item.path"
          :to="item.path"
          class="navigation-item"
          @click="closeMobileNavigation"
        >
          <span class="navigation-mark">{{ item.mark }}</span>
          <span>
            <strong>{{ item.label }}</strong>
            <small>{{ item.caption }}</small>
          </span>
        </RouterLink>
      </nav>

      <div class="rail-footer">
        <span class="environment-dot" />
        <div><strong>外网开发环境</strong><small>development / M00</small></div>
      </div>
    </aside>

    <section class="workspace">
      <header class="top-bar">
        <button
          class="mobile-menu"
          type="button"
          aria-label="打开导航"
          @click="mobileNavigationOpen = !mobileNavigationOpen"
        >
          <span /><span /><span />
        </button>
        <div class="top-bar-title">
          <span>ENTERPRISE KNOWLEDGE OPERATIONS</span>
          <strong>{{ currentTitle }}</strong>
        </div>
        <RouterLink class="user-chip" to="/settings">
          <span class="user-avatar">LY</span>
          <span><strong>研发管理员</strong><small>roles: platform_admin</small></span>
        </RouterLink>
      </header>

      <main class="page-stage">
        <RouterView />
      </main>
    </section>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  background: var(--surface-canvas);
  color: var(--text-primary);
}
.side-rail {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 20;
  width: 252px;
  display: flex;
  flex-direction: column;
  background: var(--ink-950);
  color: #f6f3eb;
}
.brand-lockup {
  height: 104px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 28px;
  border-bottom: 1px solid rgb(255 255 255 / 10%);
}
.brand-seal {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  background: var(--accent-500);
  color: var(--ink-950);
  font-family: var(--font-editorial);
  font-size: 21px;
  font-weight: 800;
}
.brand-lockup strong,
.brand-lockup small {
  display: block;
}
.brand-lockup strong {
  font-family: var(--font-editorial);
  font-size: 20px;
  letter-spacing: 0.08em;
}
.brand-lockup small {
  margin-top: 3px;
  color: var(--ink-300);
  font-size: 9px;
  letter-spacing: 0.15em;
}
.primary-navigation {
  padding: 24px 14px;
  display: grid;
  gap: 5px;
}
.navigation-item {
  position: relative;
  display: grid;
  grid-template-columns: 32px 1fr;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 8px 13px;
  color: var(--ink-300);
  text-decoration: none;
  border-left: 2px solid transparent;
  transition:
    background 0.18s ease,
    color 0.18s ease;
}
.navigation-item:hover {
  background: rgb(255 255 255 / 5%);
  color: #fff;
}
.navigation-item.router-link-active {
  background: rgb(232 126 55 / 12%);
  color: #fff;
  border-left-color: var(--accent-500);
}
.navigation-mark {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-500);
}
.navigation-item strong,
.navigation-item small {
  display: block;
}
.navigation-item strong {
  font-size: 14px;
  font-weight: 600;
}
.navigation-item small {
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 8px;
  letter-spacing: 0.12em;
  color: var(--ink-500);
}
.rail-footer {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 22px 28px 28px;
  border-top: 1px solid rgb(255 255 255 / 10%);
}
.rail-footer strong,
.rail-footer small {
  display: block;
}
.rail-footer strong {
  font-size: 11px;
  font-weight: 600;
}
.rail-footer small {
  margin-top: 2px;
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: 9px;
}
.environment-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success-500);
  box-shadow: 0 0 0 4px rgb(61 167 121 / 12%);
}
.workspace {
  min-height: 100vh;
  margin-left: 252px;
}
.top-bar {
  height: 78px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 34px;
  background: rgb(248 246 240 / 92%);
  border-bottom: 1px solid var(--line-subtle);
  backdrop-filter: blur(12px);
}
.top-bar-title span,
.top-bar-title strong {
  display: block;
}
.top-bar-title span {
  margin-bottom: 4px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.13em;
}
.top-bar-title strong {
  font-size: 15px;
  font-weight: 650;
}
.user-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  color: inherit;
  text-decoration: none;
}
.user-avatar {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line-strong);
  font-family: var(--font-mono);
  font-size: 10px;
}
.user-chip strong,
.user-chip small {
  display: block;
}
.user-chip strong {
  font-size: 11px;
}
.user-chip small {
  margin-top: 2px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 9px;
}
.page-stage {
  padding: 34px;
}
.mobile-menu {
  display: none;
}
@media (max-width: 900px) {
  .side-rail {
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    box-shadow: 16px 0 50px rgb(13 20 25 / 20%);
  }
  .side-rail.is-open {
    transform: translateX(0);
  }
  .workspace {
    margin-left: 0;
  }
  .mobile-menu {
    width: 34px;
    display: grid;
    gap: 4px;
    padding: 6px;
    border: 0;
    background: transparent;
  }
  .mobile-menu span {
    height: 1px;
    background: var(--ink-950);
  }
  .page-stage {
    padding: 22px;
  }
  .user-chip > span:last-child {
    display: none;
  }
}
</style>
