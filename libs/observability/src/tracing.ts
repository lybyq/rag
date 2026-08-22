/**
 * 在 NestJS 加载前注册 OpenTelemetry 自动埋点。
 * 入口文件必须首先导入本文件，否则 http 等模块会早于埋点被加载。
 *
 * @requirement BASE-008
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { loadAppConfig, loadProfileEnvironment } from '@rag/config';

let telemetrySdk: NodeSDK | undefined;

/** 根据配置启动 Trace SDK；关闭开关时不创建 exporter，也不会产生外部网络请求。 */
export function startTracing(): void {
  const config = loadAppConfig(loadProfileEnvironment(process.env));
  if (!config.otel.tracesEnabled || telemetrySdk) return;

  const endpoint = config.otel.endpoint;
  telemetrySdk = new NodeSDK({
    serviceName: `${config.otel.namespace}.${config.appName}`,
    ...(endpoint
      ? {
          traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
        }
      : {}),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  telemetrySdk.start();
}

/** 在进程优雅退出时刷新尚未发送的 Span。 */
export async function stopTracing(): Promise<void> {
  await telemetrySdk?.shutdown();
  telemetrySdk = undefined;
}
