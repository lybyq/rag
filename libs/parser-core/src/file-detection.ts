/**
 * 通过文件头、扩展名和声明 MIME 三方交叉识别格式。
 * 扩展名和浏览器 Content-Type 都是不可信提示；二进制魔数冲突时必须拒绝，不能“猜一个能解析的”。
 *
 * @requirement PAR-001
 * @requirement PAR-006
 */
import type { SupportedFileFormat } from '@rag/contracts';

/** 文件确定性问题；调用方应归类为 DOCUMENT_PROBLEM，不能无限重试。 */
export class FileRejectedError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FileRejectedError';
  }
}

/** 格式识别结果不会返回原始文件名，避免后续日志误记录用户输入。 */
export interface DetectedFileFormat {
  readonly format: SupportedFileFormat;
  readonly detectedMime: string;
  readonly warnings: readonly string[];
}

/** Office Open XML 的扩展名、MIME 与业务格式映射。 */
const officeFormats = {
  docx: {
    format: 'DOCX',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    format: 'XLSX',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  pptx: {
    format: 'PPTX',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
} as const;

/** MIME 参数（如 charset）不参与媒体类型比较。 */
function baseMime(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** 只读取最后一段扩展名；路径字符已经在 M02 被净化，但这里仍不信任目录语义。 */
function extensionOf(fileName: string): string {
  return fileName.split('.').at(-1)?.toLowerCase() ?? '';
}

/** 检查固定字节前缀。 */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

/** 浏览器不确定时允许 octet-stream，但记录警告，不能把它当成已验证 MIME。 */
function assertDeclaredMime(
  declaredMime: string,
  accepted: readonly string[],
  warnings: string[],
): void {
  const declared = baseMime(declaredMime);
  if (declared === 'application/octet-stream' || declared === '') {
    warnings.push('DECLARED_MIME_GENERIC');
    return;
  }
  if (!accepted.includes(declared)) {
    throw new FileRejectedError('MIME_MAGIC_MISMATCH', '声明 MIME 与文件魔数不一致');
  }
}

/** 判断首部是否像 UTF-8 文本；NUL 字节直接按二进制处理。 */
function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * 识别当前支持格式。
 * `header` 建议至少读取 8 KiB；本函数不读取全文件，也不负责解压 Office 容器。
 */
export function detectFileFormat(
  header: Uint8Array,
  originalFileName: string,
  declaredMime: string,
): DetectedFileFormat {
  const extension = extensionOf(originalFileName);
  const warnings: string[] = [];

  if (startsWith(header, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    if (extension !== 'pdf') {
      throw new FileRejectedError('EXTENSION_MAGIC_MISMATCH', 'PDF 魔数与文件扩展名不一致');
    }
    assertDeclaredMime(declaredMime, ['application/pdf'], warnings);
    return { format: 'PDF', detectedMime: 'application/pdf', warnings };
  }

  if (startsWith(header, [0x50, 0x4b, 0x03, 0x04])) {
    const office = officeFormats[extension as keyof typeof officeFormats];
    if (!office) {
      throw new FileRejectedError('UNSUPPORTED_ZIP_CONTAINER', '不支持的 ZIP 容器');
    }
    assertDeclaredMime(declaredMime, [office.mime], warnings);
    return { format: office.format, detectedMime: office.mime, warnings };
  }

  const image = detectImage(header);
  if (image) {
    if (!['png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff', 'bmp', 'webp'].includes(extension)) {
      throw new FileRejectedError('EXTENSION_MAGIC_MISMATCH', '图片魔数与文件扩展名不一致');
    }
    assertDeclaredMime(declaredMime, [image], warnings);
    return { format: 'IMAGE', detectedMime: image, warnings };
  }

  if (!isUtf8Text(header)) {
    throw new FileRejectedError(
      'UNSUPPORTED_BINARY_FORMAT',
      '文件不是受支持的格式或合法 UTF-8 文本',
    );
  }

  const text = new TextDecoder()
    .decode(header)
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (extension === 'html' || extension === 'htm') {
    if (!text.startsWith('<!doctype html') && !text.startsWith('<html')) {
      throw new FileRejectedError('HTML_SIGNATURE_MISMATCH', 'HTML 扩展名但未检测到 HTML 文档头');
    }
    assertDeclaredMime(declaredMime, ['text/html'], warnings);
    return { format: 'HTML', detectedMime: 'text/html', warnings };
  }

  const textFormats = {
    md: { format: 'MARKDOWN', mime: 'text/markdown', accepted: ['text/markdown', 'text/plain'] },
    markdown: {
      format: 'MARKDOWN',
      mime: 'text/markdown',
      accepted: ['text/markdown', 'text/plain'],
    },
    txt: { format: 'TEXT', mime: 'text/plain', accepted: ['text/plain'] },
    csv: { format: 'CSV', mime: 'text/csv', accepted: ['text/csv', 'text/plain'] },
  } as const;
  const selected = textFormats[extension as keyof typeof textFormats];
  if (!selected) {
    throw new FileRejectedError('UNSUPPORTED_TEXT_EXTENSION', 'UTF-8 文本使用了不支持的扩展名');
  }
  assertDeclaredMime(declaredMime, selected.accepted, warnings);
  return { format: selected.format, detectedMime: selected.mime, warnings };
}

/** 返回已识别图片 MIME，未知时返回 undefined。 */
function detectImage(header: Uint8Array): string | undefined {
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(header, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(header, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(header, [0x49, 0x49, 0x2a, 0x00]) || startsWith(header, [0x4d, 0x4d, 0x00, 0x2a]))
    return 'image/tiff';
  if (startsWith(header, [0x42, 0x4d])) return 'image/bmp';
  if (
    startsWith(header, [0x52, 0x49, 0x46, 0x46]) &&
    String.fromCharCode(...header.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return undefined;
}
