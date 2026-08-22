/**
 * OOXML ZIP 容器的安全读取器。
 * 在任何 DOCX/XLSX/PPTX 业务解析前检查路径穿越、加密标志、条目数、单项/总体解压比、
 * 宏、ActiveX、嵌入对象和外链关系，并只保留解析所需的小型 XML/媒体字节。
 * 它不把 ZIP 解压到文件系统，因此不会发生 Zip Slip，也不会执行嵌入内容。
 *
 * @requirement PAR-003
 * @requirement PAR-004
 * @requirement PAR-006
 * @requirement PAR-011
 * @requirement PAR-013
 */
import { XMLParser } from 'fast-xml-parser';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import type { SupportedFileFormat } from '@rag/contracts';
import type { DocumentParserLimits } from './types';
import { DocumentParserError, throwIfAborted } from './types';

/** 安全检查后允许各 Office Parser 使用的只读容器视图。 */
export interface SafeOfficeArchive {
  readonly format: Extract<SupportedFileFormat, 'DOCX' | 'XLSX' | 'PPTX'>;
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly entryNames: readonly string[];
  readonly encrypted: boolean;
  readonly hasMacros: boolean;
  readonly embeddedObjectCount: number;
  readonly externalLinkCount: number;
  readonly archiveDepth: number;
  readonly compressedSizeBytes: number;
  readonly uncompressedSizeBytes: number;
}

/** 内部 ZIP 读取期间累积的有限状态。 */
interface ArchiveAccumulator {
  readonly storedEntries: Map<string, Uint8Array>;
  readonly entryNames: string[];
  readonly entryNameSet: Set<string>;
  encrypted: boolean;
  storedBytes: number;
  compressedSizeBytes: number;
  uncompressedSizeBytes: number;
}

/**
 * 从内存 Buffer 安全读取 OOXML。
 * 调用方已执行文件总大小上限；这里先使用 central directory 元数据拒绝明显炸弹，再打开 entry 流。
 */
export async function readSafeOfficeArchive(
  bytes: Uint8Array,
  expectedFormat: Extract<SupportedFileFormat, 'DOCX' | 'XLSX' | 'PPTX'>,
  limits: DocumentParserLimits,
  signal: AbortSignal,
): Promise<SafeOfficeArchive> {
  const zipFile = await openZip(bytes);
  const accumulator: ArchiveAccumulator = {
    storedEntries: new Map(),
    entryNames: [],
    entryNameSet: new Set(),
    encrypted: false,
    storedBytes: 0,
    compressedSizeBytes: 0,
    uncompressedSizeBytes: 0,
  };

  try {
    await consumeEntries(zipFile, accumulator, limits, signal);
  } finally {
    zipFile.close();
  }

  const format = detectOfficeFormat(new Set(accumulator.entryNames));
  if (format !== expectedFormat) {
    throw new DocumentParserError(
      'OOXML_INTERNAL_FORMAT_MISMATCH',
      'Office 容器内部事实与声明格式不一致',
    );
  }
  const entryNames = [...accumulator.entryNames].sort();
  const archiveDepth = inferArchiveDepth(entryNames);
  if (archiveDepth > limits.maxArchiveDepth) {
    throw new DocumentParserError('ARCHIVE_DEPTH_EXCEEDED', '压缩嵌套层数超过安全上限');
  }

  return {
    format,
    entries: accumulator.storedEntries,
    entryNames,
    encrypted: accumulator.encrypted,
    hasMacros: entryNames.some(isMacroEntry),
    embeddedObjectCount: entryNames.filter(isEmbeddedObjectEntry).length,
    externalLinkCount: countExternalRelationships(accumulator.storedEntries),
    archiveDepth,
    compressedSizeBytes: accumulator.compressedSizeBytes,
    uncompressedSizeBytes: accumulator.uncompressedSizeBytes,
  };
}

/** 打开 ZIP 时禁用自动 entry 遍历，以便每项校验后才继续。 */
function openZip(bytes: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromBuffer(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(
            new DocumentParserError('OOXML_ZIP_INVALID', 'Office ZIP 容器损坏', { cause: error }),
          );
          return;
        }
        resolve(zipFile);
      },
    );
  });
}

/** 顺序消费全部 entry；串行读取避免多个解压流共同放大内存。 */
function consumeEntries(
  zipFile: ZipFile,
  accumulator: ArchiveAccumulator,
  limits: DocumentParserLimits,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(
        error instanceof DocumentParserError
          ? error
          : new DocumentParserError('OOXML_ZIP_READ_FAILED', 'Office ZIP 读取失败', {
              cause: error,
            }),
      );
    };
    const onAbort = (): void => fail(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    zipFile.once('error', fail);
    zipFile.once('end', () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
    zipFile.on('entry', (entry: Entry) => {
      void processEntry(zipFile, entry, accumulator, limits, signal)
        .then(() => zipFile.readEntry())
        .catch(fail);
    });
    zipFile.readEntry();
  });
}

/** 校验 central directory 事实并在需要时保存有限 entry 内容。 */
async function processEntry(
  zipFile: ZipFile,
  entry: Entry,
  accumulator: ArchiveAccumulator,
  limits: DocumentParserLimits,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const name = normalizeEntryName(entry.fileName);
  if (accumulator.entryNameSet.has(name)) {
    // 重名条目会让安全检查器与第三方 Parser 可能读取不同内容，是典型 ZIP 混淆手法。
    throw new DocumentParserError('OOXML_DUPLICATE_ENTRY', 'Office ZIP 包含重复条目');
  }
  accumulator.entryNameSet.add(name);
  accumulator.entryNames.push(name);
  if (accumulator.entryNames.length > limits.maxArchiveEntries) {
    throw new DocumentParserError('ARCHIVE_ENTRY_LIMIT_EXCEEDED', '压缩条目数量超过安全上限');
  }
  accumulator.encrypted ||= (entry.generalPurposeBitFlag & 0x1) !== 0;
  if (accumulator.encrypted) {
    throw new DocumentParserError('OOXML_ENCRYPTED_UNSUPPORTED', '加密 Office 文件无法安全解析');
  }
  accumulator.compressedSizeBytes += entry.compressedSize;
  accumulator.uncompressedSizeBytes += entry.uncompressedSize;

  const entryRatio =
    entry.compressedSize === 0
      ? entry.uncompressedSize > 0
        ? Number.POSITIVE_INFINITY
        : 1
      : entry.uncompressedSize / entry.compressedSize;
  const totalRatio =
    accumulator.compressedSizeBytes === 0
      ? accumulator.uncompressedSizeBytes > 0
        ? Number.POSITIVE_INFINITY
        : 1
      : accumulator.uncompressedSizeBytes / accumulator.compressedSizeBytes;
  if (entryRatio > limits.maxCompressionRatio || totalRatio > limits.maxCompressionRatio) {
    throw new DocumentParserError('COMPRESSION_RATIO_EXCEEDED', 'Office 容器解压比例超过安全上限');
  }
  if (name.endsWith('/')) return;

  const shouldStore = isParserEntry(name);
  if (shouldStore && entry.uncompressedSize > limits.maxXmlEntryBytes) {
    throw new DocumentParserError('OOXML_ENTRY_TOO_LARGE', 'Office 解析条目超过单项安全上限');
  }
  if (shouldStore && accumulator.storedBytes + entry.uncompressedSize > limits.maxInputBytes) {
    // 单项都不大并不代表总体安全；必须限制所有 XML/关系/媒体的累计物化内存。
    throw new DocumentParserError(
      'OOXML_MATERIALIZED_SIZE_EXCEEDED',
      'Office 解析条目累计大小超过安全上限',
    );
  }
  // 即便不保存内容也打开并消费流，让 yauzl 校验实际解压大小与 CRC/结束边界。
  const content = await readEntryStream(
    zipFile,
    entry,
    shouldStore,
    limits.maxXmlEntryBytes,
    signal,
  );
  if (content) {
    accumulator.storedBytes += content.byteLength;
    accumulator.storedEntries.set(name, content);
  }
}

/** entry 流在上限内累积；不需要保存的二进制对象只计数并丢弃。 */
function readEntryStream(
  zipFile: ZipFile,
  entry: Entry,
  store: boolean,
  maximumStoredBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new DocumentParserError('OOXML_ENTRY_READ_FAILED', 'Office 条目读取失败', {
            cause: error,
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let storedBytes = 0;
      const onAbort = (): void => {
        stream.destroy(signal.reason as Error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      stream.on('data', (chunk: Buffer) => {
        if (!store) return;
        storedBytes += chunk.byteLength;
        if (storedBytes > maximumStoredBytes) {
          stream.destroy(
            new DocumentParserError('OOXML_ENTRY_TOO_LARGE', 'Office 解析条目超过单项安全上限'),
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.once('error', (streamError) => {
        signal.removeEventListener('abort', onAbort);
        reject(streamError);
      });
      stream.once('end', () => {
        signal.removeEventListener('abort', onAbort);
        resolve(store ? Buffer.concat(chunks) : undefined);
      });
    });
  });
}

/** 路径规范化是 Zip Slip 的核心门禁；反斜线、绝对路径、NUL 和 `..` 一律拒绝。 */
function normalizeEntryName(name: string): string {
  if (
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((segment) => segment === '..')
  ) {
    throw new DocumentParserError('OOXML_UNSAFE_ENTRY_PATH', 'Office ZIP 包含不安全条目路径');
  }
  return name;
}

/** 只根据 OOXML 必需部件认定具体 Office 格式。 */
function detectOfficeFormat(
  names: ReadonlySet<string>,
): Extract<SupportedFileFormat, 'DOCX' | 'XLSX' | 'PPTX'> {
  const matches = [
    names.has('word/document.xml') ? 'DOCX' : null,
    names.has('xl/workbook.xml') ? 'XLSX' : null,
    names.has('ppt/presentation.xml') ? 'PPTX' : null,
  ].filter((format): format is 'DOCX' | 'XLSX' | 'PPTX' => format !== null);
  if (matches.length !== 1) {
    throw new DocumentParserError('OOXML_FORMAT_AMBIGUOUS', 'Office ZIP 缺少唯一的格式核心部件');
  }
  return matches[0] as 'DOCX' | 'XLSX' | 'PPTX';
}

/** XML、关系和媒体头是当前 Parser 的必要输入；嵌入对象本身永不载入内存或执行。 */
function isParserEntry(name: string): boolean {
  return (
    name.endsWith('.xml') ||
    name.endsWith('.rels') ||
    name.startsWith('word/media/') ||
    name.startsWith('xl/media/') ||
    name.startsWith('ppt/media/')
  );
}

/** Office 宏和 ActiveX 均属于可执行内容，结构门禁会直接拒绝。 */
function isMacroEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith('/vbaproject.bin') ||
    lower.includes('/macrosheets/') ||
    lower.includes('/activex/')
  );
}

/** OLE/包对象与 ActiveX 计入人工复核项，不把普通图片误计为嵌入对象。 */
function isEmbeddedObjectEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('/embeddings/') || lower.includes('/activex/');
}

/** 通过后缀保守估算嵌套压缩深度；嵌入包不会被递归解压。 */
function inferArchiveDepth(names: readonly string[]): number {
  return names.some((name) => /\.(zip|docx|xlsx|pptx)$/i.test(name)) ? 2 : 1;
}

/** 逐个关系文件统计 TargetMode=External，XML 损坏时 fail closed。 */
function countExternalRelationships(entries: ReadonlyMap<string, Uint8Array>): number {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let count = 0;
  for (const [name, bytes] of entries) {
    if (!name.endsWith('.rels')) continue;
    let document: unknown;
    try {
      document = parser.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new DocumentParserError('OOXML_RELATIONSHIP_XML_INVALID', 'Office 关系 XML 损坏', {
        cause: error,
      });
    }
    walkObject(document, (value) => {
      if (String(value['@_TargetMode'] ?? '').toLowerCase() === 'external') count += 1;
    });
  }
  return count;
}

/** 无递归业务语义的对象遍历，仅用于查找关系属性。 */
function walkObject(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObject(item, visit);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) walkObject(child, visit);
}
