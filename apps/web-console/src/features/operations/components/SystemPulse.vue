<script setup lang="ts">
import { useServiceHealth } from '../composables/useServiceHealth';

const { services, refreshing, availableCount, refresh } = useServiceHealth();
</script>

<template>
  <section class="pulse-panel" aria-labelledby="system-pulse-title">
    <header>
      <div>
        <span class="section-index">01 / SYSTEM PULSE</span>
        <h2 id="system-pulse-title">进程运行脉搏</h2>
      </div>
      <button class="text-action" type="button" :disabled="refreshing" @click="refresh">
        {{ refreshing ? '检查中…' : '重新检查' }}
      </button>
    </header>

    <div class="availability-line">
      <strong>{{ availableCount }}</strong
      ><span>/ 4 服务可用</span>
      <small>健康检查失败不会阻塞控制台，便于开发时诊断未启动的进程。</small>
    </div>

    <div class="service-grid">
      <article v-for="service in services" :key="service.key" class="service-row">
        <span class="status-lamp" :class="`is-${service.status}`" />
        <div>
          <strong>{{ service.name }}</strong>
          <small>{{ service.role }}</small>
        </div>
        <span class="latency">{{
          service.latencyMs === undefined ? '—' : `${Math.round(service.latencyMs)}ms`
        }}</span>
        <span class="status-label">{{ service.status }}</span>
      </article>
    </div>
  </section>
</template>

<style scoped>
.pulse-panel {
  grid-column: span 7;
  padding: 26px;
  color: #f8f5ed;
  background: var(--ink-900);
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.section-index {
  color: var(--accent-400);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.13em;
}
h2 {
  margin: 8px 0 0;
  font-family: var(--font-editorial);
  font-size: 23px;
  font-weight: 650;
}
.text-action {
  padding: 5px 0;
  border: 0;
  border-bottom: 1px solid var(--ink-500);
  color: var(--ink-200);
  background: transparent;
  font-family: var(--font-mono);
  font-size: 10px;
  cursor: pointer;
}
.text-action:disabled {
  cursor: wait;
  opacity: 0.5;
}
.availability-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 32px 0 18px;
  padding-bottom: 22px;
  border-bottom: 1px solid rgb(255 255 255 / 10%);
}
.availability-line strong {
  color: var(--accent-400);
  font-family: var(--font-editorial);
  font-size: 46px;
  line-height: 1;
}
.availability-line span {
  font-size: 13px;
}
.availability-line small {
  margin-left: auto;
  max-width: 250px;
  color: var(--ink-400);
  font-size: 10px;
  line-height: 1.5;
  text-align: right;
}
.service-grid {
  display: grid;
  gap: 2px;
}
.service-row {
  display: grid;
  grid-template-columns: 12px 1fr 64px 58px;
  align-items: center;
  gap: 10px;
  padding: 12px 10px;
  background: rgb(255 255 255 / 3%);
}
.service-row strong,
.service-row small {
  display: block;
}
.service-row strong {
  font-size: 12px;
}
.service-row small {
  margin-top: 2px;
  color: var(--ink-500);
  font-size: 9px;
}
.status-lamp {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.is-up {
  background: var(--success-400);
  box-shadow: 0 0 0 4px rgb(61 167 121 / 12%);
}
.is-down {
  background: var(--danger-400);
}
.is-checking {
  background: var(--warning-400);
  animation: pulse 1s infinite alternate;
}
.latency,
.status-label {
  color: var(--ink-400);
  font-family: var(--font-mono);
  font-size: 9px;
  text-align: right;
}
.status-label {
  text-transform: uppercase;
}
@keyframes pulse {
  to {
    opacity: 0.3;
  }
}
@media (max-width: 1100px) {
  .pulse-panel {
    grid-column: span 12;
  }
}
@media (max-width: 600px) {
  .availability-line small {
    display: none;
  }
}
</style>
