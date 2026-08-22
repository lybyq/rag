/**
 * 受控图片头尺寸读取器。
 * 只支持平台文件识别已放行的 PNG/JPEG/GIF/TIFF/BMP/WebP，所有偏移读取都先检查边界，
 * JPEG/TIFF 循环次数受输入字节数严格限制；不解码像素、不执行元数据，也不猜测未知格式。
 * 它替代通用图片探测依赖，避免不需要的 ICNS/JXL/HEIF Parser 扩大不可信输入攻击面。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-013
 */
import { DocumentParserError } from './types';

/** 图片头能够证明的尺寸和规范类型。 */
export interface SafeImageDimensions {
  readonly width: number;
  readonly height: number;
  readonly type: 'png' | 'jpg' | 'gif' | 'tiff' | 'bmp' | 'webp';
}

/** 读取受支持图片的尺寸；损坏、截断和未知头统一按文档问题拒绝。 */
export function readImageDimensions(bytes: Uint8Array): SafeImageDimensions {
  let dimensions: SafeImageDimensions;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    dimensions = readPng(bytes);
  } else if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    dimensions = readJpeg(bytes);
  } else if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    dimensions = readGif(bytes);
  } else if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    dimensions = readTiff(bytes);
  } else if (startsWith(bytes, [0x42, 0x4d])) {
    dimensions = readBmp(bytes);
  } else if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === 'WEBP') {
    dimensions = readWebp(bytes);
  } else {
    throw invalidImage('图片格式不受支持或文件头损坏');
  }
  if (
    !Number.isSafeInteger(dimensions.width) ||
    !Number.isSafeInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw invalidImage('图片尺寸不是有效正整数');
  }
  return dimensions;
}

/** PNG 的 IHDR 固定包含四字节大端宽高。 */
function readPng(bytes: Uint8Array): SafeImageDimensions {
  assertRange(bytes, 12, 12);
  if (u32(bytes, 8, false) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') {
    throw invalidImage('PNG 缺少合法首个 IHDR');
  }
  return { width: u32(bytes, 16, false), height: u32(bytes, 20, false), type: 'png' };
}

/** GIF Logical Screen Descriptor 使用小端 16 位宽高。 */
function readGif(bytes: Uint8Array): SafeImageDimensions {
  assertRange(bytes, 0, 10);
  if (!['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) {
    throw invalidImage('GIF 版本签名非法');
  }
  return { width: u16(bytes, 6, true), height: u16(bytes, 8, true), type: 'gif' };
}

/** BMP 同时兼容 12 字节 COREHEADER 与常见 40+ 字节 INFOHEADER。 */
function readBmp(bytes: Uint8Array): SafeImageDimensions {
  assertRange(bytes, 14, 12);
  const dibSize = u32(bytes, 14, true);
  if (dibSize === 12) {
    return { width: u16(bytes, 18, true), height: u16(bytes, 20, true), type: 'bmp' };
  }
  if (dibSize < 40) throw invalidImage('BMP DIB Header 不受支持');
  return {
    width: Math.abs(i32(bytes, 18, true)),
    height: Math.abs(i32(bytes, 22, true)),
    type: 'bmp',
  };
}

/** JPEG 顺序扫描长度受控的 Segment，直到遇到任一 Start Of Frame。 */
function readJpeg(bytes: Uint8Array): SafeImageDimensions {
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    assertRange(bytes, offset, 2);
    const segmentLength = u16(bytes, offset, false);
    if (segmentLength < 2) throw invalidImage('JPEG Segment 长度非法');
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) throw invalidImage('JPEG SOF 长度非法');
      assertRange(bytes, offset, segmentLength);
      return {
        width: u16(bytes, offset + 5, false),
        height: u16(bytes, offset + 3, false),
        type: 'jpg',
      };
    }
    assertRange(bytes, offset, segmentLength);
    offset += segmentLength;
  }
  throw invalidImage('JPEG 未找到尺寸 Segment');
}

/** TIFF 只读取首个 IFD 的 ImageWidth/ImageLength，条目数不能超过现有字节。 */
function readTiff(bytes: Uint8Array): SafeImageDimensions {
  const littleEndian = bytes[0] === 0x49;
  const ifdOffset = u32(bytes, 4, littleEndian);
  assertRange(bytes, ifdOffset, 2);
  const entryCount = u16(bytes, ifdOffset, littleEndian);
  const entriesOffset = ifdOffset + 2;
  if (entryCount > Math.floor((bytes.byteLength - entriesOffset) / 12)) {
    throw invalidImage('TIFF IFD 条目数超过文件边界');
  }
  let width: number | null = null;
  let height: number | null = null;
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesOffset + index * 12;
    const tag = u16(bytes, entryOffset, littleEndian);
    if (tag !== 256 && tag !== 257) continue;
    const type = u16(bytes, entryOffset + 2, littleEndian);
    const count = u32(bytes, entryOffset + 4, littleEndian);
    if (count !== 1 || (type !== 3 && type !== 4)) throw invalidImage('TIFF 尺寸字段类型非法');
    const value =
      type === 3
        ? u16(bytes, entryOffset + 8, littleEndian)
        : u32(bytes, entryOffset + 8, littleEndian);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  if (width === null || height === null) throw invalidImage('TIFF 缺少宽高字段');
  return { width, height, type: 'tiff' };
}

/** WebP 根据 VP8X、VP8 或 VP8L Chunk 的公开头格式读取画布尺寸。 */
function readWebp(bytes: Uint8Array): SafeImageDimensions {
  assertRange(bytes, 12, 9);
  const subtype = ascii(bytes, 12, 4);
  if (subtype === 'VP8X') {
    assertRange(bytes, 24, 6);
    return {
      width: u24le(bytes, 24) + 1,
      height: u24le(bytes, 27) + 1,
      type: 'webp',
    };
  }
  if (subtype === 'VP8 ') {
    assertRange(bytes, 20, 10);
    if (!startsWith(bytes.slice(23), [0x9d, 0x01, 0x2a])) throw invalidImage('WebP VP8 帧头非法');
    return {
      width: u16(bytes, 26, true) & 0x3fff,
      height: u16(bytes, 28, true) & 0x3fff,
      type: 'webp',
    };
  }
  if (subtype === 'VP8L') {
    assertRange(bytes, 20, 5);
    if (bytes[20] !== 0x2f) throw invalidImage('WebP VP8L 签名非法');
    const first = bytes[21] ?? 0;
    const second = bytes[22] ?? 0;
    const third = bytes[23] ?? 0;
    const fourth = bytes[24] ?? 0;
    return {
      width: 1 + first + ((second & 0x3f) << 8),
      height: 1 + (second >> 6) + (third << 2) + ((fourth & 0x0f) << 10),
      type: 'webp',
    };
  }
  throw invalidImage('WebP Chunk 类型不受支持');
}

/** 固定前缀比较不做字符串隐式解码。 */
function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

/** 读取有限 ASCII 标识。 */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  assertRange(bytes, offset, length);
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

/** 任一整数读取前统一验证非负偏移和文件边界。 */
function assertRange(bytes: Uint8Array, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  ) {
    throw invalidImage('图片文件头被截断');
  }
}

/** 读取 16 位无符号整数。 */
function u16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  assertRange(bytes, offset, 2);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
    offset,
    littleEndian,
  );
}

/** 读取 24 位小端无符号整数。 */
function u24le(bytes: Uint8Array, offset: number): number {
  assertRange(bytes, offset, 3);
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

/** 读取 32 位无符号整数。 */
function u32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  assertRange(bytes, offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
    littleEndian,
  );
}

/** 读取 32 位有符号整数。 */
function i32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  assertRange(bytes, offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(
    offset,
    littleEndian,
  );
}

/** 图片头错误使用稳定文档问题码，不泄漏第三方 Parser 文本。 */
function invalidImage(message: string): DocumentParserError {
  return new DocumentParserError('IMAGE_HEADER_INVALID', message);
}
