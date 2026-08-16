import { MetricsService } from './metrics.service';

describe('[DOC-016] M02 业务指标', () => {
  let metrics: MetricsService | undefined;

  afterEach(() => {
    // 测试结束清理独立 Registry，避免默认进程指标的采集句柄影响其他用例。
    metrics?.onModuleDestroy();
    metrics = undefined;
  });

  it('只用低基数 operation/result 标签暴露关键动作计数', async () => {
    metrics = new MetricsService();
    metrics.m02OperationsTotal.inc({ operation: 'outbox_publish', result: 'success' }, 2);

    const rendered = await metrics.render();

    expect(rendered).toContain('rag_m02_operations_total');
    expect(rendered).toContain('operation="outbox_publish",result="success"');
    expect(rendered).toContain(' 2');
  });
});
