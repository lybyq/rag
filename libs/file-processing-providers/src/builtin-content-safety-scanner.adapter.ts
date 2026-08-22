/**
 * M03 内置流式内容安全扫描 Adapter。
 *
 * 它在文件进入 Parser 前识别 EICAR 验收串、可执行文件魔数和明显脚本入口，
 * 同时限制扫描字节数并传播取消信号。它不是病毒特征库，也不会把“未命中这些规则”
 * 宣称为完整杀毒结论；Office 宏、嵌入对象、外链和压缩炸弹继续由 Parser 结构检查负责。
 * 本文件不解析业务文档，也不读取文件名、URL 或任何 Provider 凭据。
 *
 * @requirement PAR-002
 * @requirement PAR-003
 * @requirement PAR-013
 */
import type { MalwareScannerPort } from '@rag/application';
import type { MalwareScanResult, ProcessingProviderProfile } from '@rag/contracts';
import { ProcessingProviderError } from './provider.error';

/** 内置扫描规则的不可变配置。 */
export interface BuiltinContentSafetyScannerConfig {
  /** Profile ID 会随每次解析运行保存，用来重现当时采用的规则集。 */
  readonly profileId: string;
  /** 修改任一检测规则时必须升级 revision，不能原地改变历史含义。 */
  readonly revision: string;
  /** 防御性字节上限；即便上游大小事实错误，也不能无限消费输入流。 */
  readonly maxBytes: number;
  /** 与其他 Provider Profile 保持一致的运维超时展示值。 */
  readonly timeoutMs: number;
}

/** 命中规则后的稳定签名名；禁止把原始正文放入错误或日志。 */
interface BuiltinSignature {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly onlyAtStart: boolean;
}

const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

// EICAR 字符串故意拆段组合，避免源文件本身被宿主机安全软件误当测试样本隔离。
const eicarSignature = ascii(
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join(''),
);

/**
 * 可执行格式只允许从第 0 字节命中；EICAR 则允许出现在任意分块和任意偏移。
 * Parser 支持的 PDF、OOXML、文本和图片都不需要直接执行代码，因此这里默认拒绝二进制程序。
 */
const signatures: readonly BuiltinSignature[] = [
  { name: 'BUILTIN_EICAR_TEST_FILE', bytes: eicarSignature, onlyAtStart: false },
  { name: 'BUILTIN_EXECUTABLE_PE', bytes: Uint8Array.of(0x4d, 0x5a), onlyAtStart: true },
  {
    name: 'BUILTIN_EXECUTABLE_ELF',
    bytes: Uint8Array.of(0x7f, 0x45, 0x4c, 0x46),
    onlyAtStart: true,
  },
  {
    name: 'BUILTIN_EXECUTABLE_MACHO_32_BE',
    bytes: Uint8Array.of(0xfe, 0xed, 0xfa, 0xce),
    onlyAtStart: true,
  },
  {
    name: 'BUILTIN_EXECUTABLE_MACHO_64_BE',
    bytes: Uint8Array.of(0xfe, 0xed, 0xfa, 0xcf),
    onlyAtStart: true,
  },
  {
    name: 'BUILTIN_EXECUTABLE_MACHO_32_LE',
    bytes: Uint8Array.of(0xce, 0xfa, 0xed, 0xfe),
    onlyAtStart: true,
  },
  {
    name: 'BUILTIN_EXECUTABLE_MACHO_64_LE',
    bytes: Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe),
    onlyAtStart: true,
  },
  { name: 'BUILTIN_EXECUTABLE_SCRIPT', bytes: Uint8Array.of(0x23, 0x21), onlyAtStart: true },
];

/**
 * 纯 Node 流式扫描实现。
 *
 * 扫描器只保留“最长签名长度 - 1”的尾部，因此既能发现跨 chunk 的签名，
 * 又不会随文件大小增长内存。取消、超限或输入异常都会抛错，绝不会伪造 CLEAN。
 */
export class BuiltinContentSafetyScannerAdapter implements MalwareScannerPort {
  public constructor(private readonly config: BuiltinContentSafetyScannerConfig) {}

  /** 返回可审计能力边界；NO_SIGNATURE_DATABASE 明确提示这不是商业杀毒库。 */
  public profile(): ProcessingProviderProfile {
    return {
      kind: 'MALWARE_SCANNER',
      adapter: 'builtin',
      profileId: this.config.profileId,
      revision: this.config.revision,
      protocolVersion: 'builtin-content-safety/v1',
      endpoint: null,
      capabilities: [
        'STREAM_SCAN',
        'EICAR_TEST_SIGNATURE',
        'EXECUTABLE_MAGIC_REJECTION',
        'NO_SIGNATURE_DATABASE',
      ],
      timeoutMs: this.config.timeoutMs,
    };
  }

  /** 流式消费完整对象，并返回首个稳定命中的危险签名。 */
  public async scan(
    content: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<MalwareScanResult> {
    const startedAt = Date.now();
    const maximumSignatureLength = Math.max(...signatures.map((item) => item.bytes.byteLength));
    let tail = new Uint8Array();
    let scannedBytes = 0;
    let matchedSignature: BuiltinSignature | null = null;

    for await (const chunk of content) {
      if (signal.aborted) throw signal.reason;
      scannedBytes += chunk.byteLength;
      if (scannedBytes > this.config.maxBytes) {
        throw new ProcessingProviderError(
          'DOCUMENT_PROBLEM',
          'SCANNER_FILE_TOO_LARGE',
          '文件大小超过内置内容安全扫描上限',
        );
      }

      const window = concatBytes(tail, chunk);
      const absoluteWindowOffset = scannedBytes - window.byteLength;
      if (matchedSignature === null) {
        matchedSignature =
          signatures.find((signature) => {
            const offset = indexOfBytes(window, signature.bytes);
            return offset >= 0 && (!signature.onlyAtStart || absoluteWindowOffset + offset === 0);
          }) ?? null;
      }

      // 只保留可能参与下一块跨界匹配的尾部，避免扫描大文件时内存线性增长。
      tail = window.slice(Math.max(0, window.byteLength - maximumSignatureLength + 1));
    }

    if (signal.aborted) throw signal.reason;
    return {
      verdict: matchedSignature === null ? 'CLEAN' : 'INFECTED',
      engine: 'RAG Builtin Content Safety',
      engineRevision: this.config.revision,
      signatureName: matchedSignature?.name ?? null,
      scannedBytes,
      durationMs: Date.now() - startedAt,
    };
  }
}

/** 合并当前窗口；传入空尾部时复用 chunk，减少一次无意义复制。 */
function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

/** 在二进制窗口中查找完整签名，避免把任意字节错误转成 UTF-8 字符串。 */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return -1;
  outer: for (let start = 0; start <= haystack.byteLength - needle.byteLength; start += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}
