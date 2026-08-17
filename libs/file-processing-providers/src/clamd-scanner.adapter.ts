/**
 * ClamAV clamd INSTREAM Adapter。
 * 采用官方协议的 zINSTREAM NUL 命令、4 字节大端长度帧和零长度终止帧。
 *
 * @requirement PAR-002
 * @requirement PAR-004
 * @requirement PAR-013
 */
import type { MalwareScannerPort } from '@rag/application';
import type { MalwareScanResult, ProcessingProviderProfile } from '@rag/contracts';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { ProcessingProviderError } from './provider.error';

export interface ClamdScannerConfig {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly profileId: string;
  readonly revision: string;
}

/** clamd TCP 端口没有认证能力，部署时必须由防火墙限制到 Worker 网段。 */
export class ClamdScannerAdapter implements MalwareScannerPort {
  public constructor(private readonly config: ClamdScannerConfig) {}

  public profile(): ProcessingProviderProfile {
    return {
      kind: 'MALWARE_SCANNER',
      adapter: 'clamd',
      profileId: this.config.profileId,
      revision: this.config.revision,
      protocolVersion: 'INSTREAM-v1',
      endpoint: `${this.config.host}:${this.config.port}`,
      capabilities: ['STREAM_SCAN', 'SIGNATURE_NAME'],
      timeoutMs: this.config.timeoutMs,
    };
  }

  public async scan(
    content: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<MalwareScanResult> {
    const startedAt = Date.now();
    const socket = await connectSocket(this.config, signal);
    const onAbort = (): void => {
      socket.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    const onTimeout = (): void => {
      socket.destroy(
        new ProcessingProviderError('RETRYABLE_PROVIDER', 'SCANNER_TIMEOUT', '扫描服务响应超时'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('timeout', onTimeout);
    let scannedBytes = 0;
    try {
      await writeSocket(socket, Buffer.from('zINSTREAM\0', 'ascii'), signal);
      for await (const inputChunk of content) {
        for (let offset = 0; offset < inputChunk.byteLength; offset += 1024 * 1024) {
          const chunk = inputChunk.subarray(offset, offset + 1024 * 1024);
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(chunk.byteLength);
          await writeSocket(socket, length, signal);
          await writeSocket(socket, chunk, signal);
          scannedBytes += chunk.byteLength;
        }
      }
      await writeSocket(socket, Buffer.alloc(4), signal);
      const response = await readClamdResponse(socket, signal);
      const verdict = parseClamdResponse(response);
      const engineRevision = await queryClamdVersion(this.config, signal);
      return {
        ...verdict,
        engine: 'ClamAV clamd',
        engineRevision,
        scannedBytes,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ProcessingProviderError) throw error;
      throw new ProcessingProviderError(
        'RETRYABLE_PROVIDER',
        'SCANNER_IO_ERROR',
        '恶意软件扫描服务调用失败',
        { cause: error },
      );
    } finally {
      signal.removeEventListener('abort', onAbort);
      socket.off('timeout', onTimeout);
      socket.destroy();
    }
  }
}

/** VERSION 命令同时记录引擎和签名库 revision，避免只把配置期望值冒充实际值。 */
async function queryClamdVersion(config: ClamdScannerConfig, signal: AbortSignal): Promise<string> {
  const socket = await connectSocket(config, signal);
  const onAbort = (): void => {
    socket.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  };
  const onTimeout = (): void => {
    socket.destroy(
      new ProcessingProviderError('RETRYABLE_PROVIDER', 'SCANNER_TIMEOUT', '扫描器版本查询超时'),
    );
  };
  signal.addEventListener('abort', onAbort, { once: true });
  socket.once('timeout', onTimeout);
  try {
    await writeSocket(socket, Buffer.from('zVERSION\0', 'ascii'), signal);
    const version = (await readClamdResponse(socket, signal)).replaceAll('\0', '').trim();
    if (!version.startsWith(config.revision)) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'SCANNER_REVISION_MISMATCH',
        '扫描器实际修订与配置 Profile 不一致',
      );
    }
    return version.slice(0, 100);
  } finally {
    signal.removeEventListener('abort', onAbort);
    socket.off('timeout', onTimeout);
    socket.destroy();
  }
}

/** 把 clamd 文本结果收窄成稳定 verdict；协议漂移视为开发缺陷。 */
export function parseClamdResponse(
  rawResponse: string,
): Pick<MalwareScanResult, 'verdict' | 'signatureName'> {
  const response = rawResponse.replaceAll('\0', '').trim();
  if (response.endsWith(' OK')) return { verdict: 'CLEAN', signatureName: null };
  const match = response.match(/^stream: (.+) FOUND$/);
  if (match?.[1]) return { verdict: 'INFECTED', signatureName: match[1] };
  throw new ProcessingProviderError(
    'DEVELOPER_DEFECT',
    'SCANNER_PROTOCOL_MISMATCH',
    '恶意软件扫描器返回了未知协议响应',
  );
}

async function connectSocket(config: ClamdScannerConfig, signal: AbortSignal): Promise<Socket> {
  if (signal.aborted) throw signal.reason;
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: config.host, port: config.port });
    socket.setTimeout(config.timeoutMs);
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
    };
    const onAbort = (): void => {
      socket.destroy(signal.reason as Error);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onTimeout = (): void => {
      socket.destroy(
        new ProcessingProviderError('RETRYABLE_PROVIDER', 'SCANNER_TIMEOUT', '扫描服务连接超时'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.once('connect', () => {
      cleanup();
      resolve(socket);
    });
  });
}

async function writeSocket(socket: Socket, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  if (!socket.write(bytes)) await once(socket, 'drain');
}

async function readClamdResponse(socket: Socket, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of socket) {
    if (signal.aborted) throw signal.reason;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    if (bytes.includes(0) || Buffer.concat(chunks).includes(0x0a)) break;
    if (chunks.reduce((sum, value) => sum + value.byteLength, 0) > 4_096) {
      throw new ProcessingProviderError(
        'DEVELOPER_DEFECT',
        'SCANNER_RESPONSE_TOO_LARGE',
        '扫描服务响应超过协议上限',
      );
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}
