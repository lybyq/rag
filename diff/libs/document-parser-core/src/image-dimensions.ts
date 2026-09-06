/**
 * 受控图片头与内容单元检查器。
 * 只检查平台白名单内的 PNG/JPEG/GIF/TIFF/BMP/WebP，不解码像素、不执行元数据；
 * 除首图宽高外还完整枚举可导致重复解码的页/帧，并保留 EXIF Orientation 检查事实。
 * 未支持格式、损坏边界、循环 TIFF IFD 和帧声明不一致都会稳定失败，不能静默只读首页。
 *
 * @requirement PAR-003
 * @requirement PAR-006
 * @requirement PAR-013
 * @requirement PAR-023
 */
import { DocumentParserError } from './types';

/** 图片头能够证明的尺寸和规范类型；保留旧调用方需要的最小接口。 */
export interface SafeImageDimensions {
  readonly width: number;
  readonly height: number;
  readonly type: 'png' | 'jpg' | 'gif' | 'tiff' | 'bmp' | 'webp';
}

/** 一张 TIFF 页面或一个动画帧的安全预算事实。 */
export interface SafeImageContentUnit {
  readonly width: number;
  readonly height: number;
  readonly orientation: number | null;
}

/** 图片检查的完整结果；orientation=null 不等于检查失败，需结合 complete 字段解释。 */
export interface SafeImageInspection extends SafeImageDimensions {
  readonly contentUnitKind: 'IMAGE' | 'PAGE' | 'FRAME';
  readonly unitCount: number;
  readonly animated: boolean;
  readonly orientation: number | null;
  readonly orientationInspectionComplete: boolean;
  readonly storageOrder: 'TOP_DOWN' | 'BOTTOM_UP' | null;
  readonly units: readonly SafeImageContentUnit[];
}

/**
 * 兼容只需要首图宽高的 Office 调用方。
 * 该函数严格验证宽高字段，但不会要求把整份动画/多页容器扫描完；完整图片入口应调用 inspectImage。
 */
export function readImageDimensions(bytes: Uint8Array): SafeImageDimensions {
  const dimensions = readPrimaryDimensions(bytes);
  return { width: dimensions.width, height: dimensions.height, type: dimensions.type };
}

/** 完整检查独立图片文件，并用 maximumUnits 在恶意帧/IFD 链继续增长前终止。 */
export function inspectImage(bytes: Uint8Array, maximumUnits = 100_000): SafeImageInspection {
  assertPositiveInteger(maximumUnits, '图片内容单元上限非法');
  let inspection: SafeImageInspection;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    inspection = inspectPng(bytes, maximumUnits);
  } else if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    inspection = inspectJpeg(bytes);
  } else if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    inspection = inspectGif(bytes, maximumUnits);
  } else if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    inspection = inspectTiff(bytes, maximumUnits);
  } else if (startsWith(bytes, [0x42, 0x4d])) {
    inspection = inspectBmp(bytes);
  } else if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === 'WEBP') {
    inspection = inspectWebp(bytes, maximumUnits);
  } else {
    throw invalidImage('图片格式不受支持或文件头损坏');
  }
  assertDimensions(inspection);
  return inspection;
}

/** 只读取各格式首图尺寸，供嵌入 Office 媒体做低成本检查。 */
function readPrimaryDimensions(bytes: Uint8Array): SafeImageDimensions {
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
  assertDimensions(dimensions);
  return dimensions;
}

/** PNG 的 IHDR 固定包含四字节大端宽高。 */
function readPng(bytes: Uint8Array): SafeImageDimensions {
  assertRange(bytes, 8, 25);
  if (u32(bytes, 8, false) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') {
    throw invalidImage('PNG 缺少合法首个 IHDR');
  }
  return { width: u32(bytes, 16, false), height: u32(bytes, 20, false), type: 'png' };
}

/** 扫描 PNG Chunk，识别 APNG 帧与 eXIf；不计算 CRC，但严格验证所有声明长度。 */
function inspectPng(bytes: Uint8Array, maximumUnits: number): SafeImageInspection {
  const primary = readPng(bytes);
  const frameUnits: SafeImageContentUnit[] = [];
  let declaredFrames: number | null = null;
  let orientation: number | null = null;
  let orientationInspectionComplete = true;
  let foundEnd = false;
  let offset = 8;
  while (offset < bytes.byteLength) {
    assertRange(bytes, offset, 12);
    const dataLength = u32(bytes, offset, false);
    const chunkLength = checkedChunkLength(dataLength, 12);
    assertRange(bytes, offset, chunkLength);
    const type = ascii(bytes, offset + 4, 4);
    const dataOffset = offset + 8;
    if (type === 'acTL') {
      if (dataLength !== 8) throw invalidImage('APNG acTL 长度非法');
      if (declaredFrames !== null) throw invalidImage('APNG 出现重复 acTL');
      declaredFrames = u32(bytes, dataOffset, false);
      assertUnitCount(declaredFrames, maximumUnits);
    } else if (type === 'fcTL') {
      if (dataLength !== 26) throw invalidImage('APNG fcTL 长度非法');
      assertUnitCount(frameUnits.length + 1, maximumUnits);
      frameUnits.push({
        width: u32(bytes, dataOffset + 4, false),
        height: u32(bytes, dataOffset + 8, false),
        orientation: null,
      });
    } else if (type === 'eXIf') {
      const fact = tryReadExifOrientation(bytes.subarray(dataOffset, dataOffset + dataLength));
      orientation = fact.orientation;
      orientationInspectionComplete = fact.complete;
    } else if (type === 'IEND') {
      if (dataLength !== 0) throw invalidImage('PNG IEND 长度非法');
      foundEnd = true;
      offset += chunkLength;
      break;
    }
    offset += chunkLength;
  }
  if (!foundEnd) throw invalidImage('PNG 缺少 IEND 或 Chunk 被截断');
  if (declaredFrames === null && frameUnits.length > 0) throw invalidImage('APNG fcTL 缺少 acTL');
  if (declaredFrames !== null && (declaredFrames < 1 || declaredFrames !== frameUnits.length)) {
    throw invalidImage('APNG 声明帧数与 fcTL 数量不一致');
  }
  const units =
    declaredFrames === null
      ? [{ width: primary.width, height: primary.height, orientation }]
      : frameUnits.map(() => ({
          // APNG 解码时每帧要参与完整画布合成，安全预算按画布计，不按局部帧矩形低估。
          width: primary.width,
          height: primary.height,
          orientation,
        }));
  for (const unit of units) assertDimensions(unit);
  return {
    ...primary,
    contentUnitKind: declaredFrames === null ? 'IMAGE' : 'FRAME',
    unitCount: units.length,
    animated: units.length > 1,
    orientation,
    orientationInspectionComplete,
    storageOrder: null,
    units,
  };
}

/** GIF Logical Screen Descriptor 使用小端 16 位宽高。 */
function readGif(bytes: Uint8Array): SafeImageDimensions {
  assertRange(bytes, 0, 10);
  if (!['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) {
    throw invalidImage('GIF 版本签名非法');
  }
  return { width: u16(bytes, 6, true), height: u16(bytes, 8, true), type: 'gif' };
}

/** 完整走过 GIF Block 链以确认帧数；图像数据仅跳过有界 sub-block，不做 LZW 解码。 */
function inspectGif(bytes: Uint8Array, maximumUnits: number): SafeImageInspection {
  const primary = readGif(bytes);
  assertRange(bytes, 0, 13);
  const packed = bytes[10] ?? 0;
  let offset = 13;
  if ((packed & 0x80) !== 0) {
    const colorTableBytes = 3 * 2 ** ((packed & 0x07) + 1);
    assertRange(bytes, offset, colorTableBytes);
    offset += colorTableBytes;
  }
  let frameCount = 0;
  let foundTrailer = false;
  while (offset < bytes.byteLength) {
    const marker = bytes[offset] ?? -1;
    if (marker === 0x3b) {
      foundTrailer = true;
      offset += 1;
      break;
    }
    if (marker === 0x21) {
      assertRange(bytes, offset, 2);
      offset = skipSubBlocks(bytes, offset + 2);
      continue;
    }
    if (marker !== 0x2c) throw invalidImage('GIF 出现未知 Block 标识');
    assertRange(bytes, offset, 10);
    const frameWidth = u16(bytes, offset + 5, true);
    const frameHeight = u16(bytes, offset + 7, true);
    assertDimensions({ width: frameWidth, height: frameHeight });
    frameCount += 1;
    assertUnitCount(frameCount, maximumUnits);
    const localPacked = bytes[offset + 9] ?? 0;
    offset += 10;
    if ((localPacked & 0x80) !== 0) {
      const localColorTableBytes = 3 * 2 ** ((localPacked & 0x07) + 1);
      assertRange(bytes, offset, localColorTableBytes);
      offset += localColorTableBytes;
    }
    assertRange(bytes, offset, 1);
    offset = skipSubBlocks(bytes, offset + 1);
  }
  if (!foundTrailer || frameCount === 0) throw invalidImage('GIF 缺少完整图像帧或 Trailer');
  // GIF 每帧会在逻辑画布上合成，预算按完整画布×帧数，而不是只算局部 frame rectangle。
  const units = Array.from({ length: frameCount }, () => ({
    width: primary.width,
    height: primary.height,
    orientation: null,
  }));
  return {
    ...primary,
    contentUnitKind: 'FRAME',
    unitCount: frameCount,
    animated: frameCount > 1,
    orientation: null,
    orientationInspectionComplete: true,
    storageOrder: null,
    units,
  };
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

/** BMP 负高度表示 top-down 存储；保留事实但不把它误称为 EXIF 旋转。 */
function inspectBmp(bytes: Uint8Array): SafeImageInspection {
  const primary = readBmp(bytes);
  const dibSize = u32(bytes, 14, true);
  assertRange(bytes, 14, dibSize);
  const storageOrder = dibSize >= 40 && i32(bytes, 22, true) < 0 ? 'TOP_DOWN' : 'BOTTOM_UP';
  return staticInspection(primary, null, true, storageOrder);
}

/** JPEG 顺序扫描长度受控的 Segment，直到遇到任一 Start Of Frame。 */
function readJpeg(bytes: Uint8Array): SafeImageDimensions {
  return scanJpeg(bytes).dimensions;
}

/** JPEG APP1 EXIF 与 SOF 在同一次线性扫描中读取，避免对恶意 Segment 重复遍历。 */
function inspectJpeg(bytes: Uint8Array): SafeImageInspection {
  const scanned = scanJpeg(bytes);
  return staticInspection(
    scanned.dimensions,
    scanned.orientation,
    scanned.orientationInspectionComplete,
    null,
  );
}

/** JPEG 扫描的最小内部事实。 */
function scanJpeg(bytes: Uint8Array): {
  readonly dimensions: SafeImageDimensions;
  readonly orientation: number | null;
  readonly orientationInspectionComplete: boolean;
} {
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  let dimensions: SafeImageDimensions | null = null;
  let orientation: number | null = null;
  let orientationInspectionComplete = true;
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
    assertRange(bytes, offset, segmentLength);
    const dataOffset = offset + 2;
    const dataLength = segmentLength - 2;
    if (marker === 0xe1 && dataLength >= 6 && ascii(bytes, dataOffset, 6) === 'Exif\0\0') {
      const fact = tryReadExifOrientation(bytes.subarray(dataOffset + 6, dataOffset + dataLength));
      orientation = fact.orientation;
      orientationInspectionComplete = fact.complete;
    }
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) throw invalidImage('JPEG SOF 长度非法');
      dimensions = {
        width: u16(bytes, offset + 5, false),
        height: u16(bytes, offset + 3, false),
        type: 'jpg',
      };
    }
    offset += segmentLength;
  }
  if (!dimensions) throw invalidImage('JPEG 未找到尺寸 Segment');
  assertDimensions(dimensions);
  return { dimensions, orientation, orientationInspectionComplete };
}

/** TIFF 首个 IFD 的兼容宽高读取。 */
function readTiff(bytes: Uint8Array): SafeImageDimensions {
  const inspected = inspectTiff(bytes, 100_000);
  return { width: inspected.width, height: inspected.height, type: 'tiff' };
}

/** 遍历完整 TIFF IFD 链，检测循环、越界、多页尺寸和每页 Orientation。 */
function inspectTiff(bytes: Uint8Array, maximumUnits: number): SafeImageInspection {
  assertRange(bytes, 0, 8);
  const littleEndian = bytes[0] === 0x49;
  const byteOrderValid = littleEndian
    ? bytes[1] === 0x49 && u16(bytes, 2, true) === 42
    : bytes[0] === 0x4d && bytes[1] === 0x4d && u16(bytes, 2, false) === 42;
  if (!byteOrderValid) throw invalidImage('TIFF 字节序或版本非法');
  let ifdOffset = u32(bytes, 4, littleEndian);
  const visited = new Set<number>();
  const units: SafeImageContentUnit[] = [];
  let orientationInspectionComplete = true;
  while (ifdOffset !== 0) {
    if (visited.has(ifdOffset)) throw invalidImage('TIFF IFD 链出现循环');
    visited.add(ifdOffset);
    assertUnitCount(units.length + 1, maximumUnits);
    const directory = readTiffDirectory(bytes, ifdOffset, littleEndian);
    units.push({
      width: directory.width,
      height: directory.height,
      orientation: directory.orientation,
    });
    orientationInspectionComplete &&= directory.orientationValid;
    ifdOffset = directory.nextIfdOffset;
  }
  const first = units[0];
  if (!first) throw invalidImage('TIFF 不包含图像 IFD');
  return {
    width: first.width,
    height: first.height,
    type: 'tiff',
    contentUnitKind: 'PAGE',
    unitCount: units.length,
    animated: false,
    orientation: first.orientation,
    orientationInspectionComplete,
    storageOrder: null,
    units,
  };
}

/** 读取单个 TIFF IFD；宽高只接受 count=1 的 SHORT/LONG，防止跟随任意外部偏移。 */
function readTiffDirectory(
  bytes: Uint8Array,
  ifdOffset: number,
  littleEndian: boolean,
): {
  readonly width: number;
  readonly height: number;
  readonly orientation: number | null;
  readonly orientationValid: boolean;
  readonly nextIfdOffset: number;
} {
  assertRange(bytes, ifdOffset, 2);
  const entryCount = u16(bytes, ifdOffset, littleEndian);
  const entriesOffset = ifdOffset + 2;
  const entriesLength = checkedProduct(entryCount, 12, 'TIFF IFD 条目数溢出');
  assertRange(bytes, entriesOffset, checkedChunkLength(entriesLength, 4));
  let width: number | null = null;
  let height: number | null = null;
  let orientation: number | null = null;
  let orientationValid = true;
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesOffset + index * 12;
    const tag = u16(bytes, entryOffset, littleEndian);
    if (tag !== 256 && tag !== 257 && tag !== 274) continue;
    const type = u16(bytes, entryOffset + 2, littleEndian);
    const count = u32(bytes, entryOffset + 4, littleEndian);
    if (count !== 1 || (type !== 3 && type !== 4)) {
      if (tag === 274) orientationValid = false;
      else throw invalidImage('TIFF 尺寸字段类型非法');
      continue;
    }
    const value =
      type === 3
        ? u16(bytes, entryOffset + 8, littleEndian)
        : u32(bytes, entryOffset + 8, littleEndian);
    if (tag === 256) width = value;
    else if (tag === 257) height = value;
    else if (value >= 1 && value <= 8) orientation = value;
    else orientationValid = false;
  }
  if (width === null || height === null) throw invalidImage('TIFF 缺少宽高字段');
  assertDimensions({ width, height });
  return {
    width,
    height,
    orientation,
    orientationValid,
    nextIfdOffset: u32(bytes, entriesOffset + entriesLength, littleEndian),
  };
}

/** WebP 根据 VP8X、VP8 或 VP8L Chunk 的公开头格式读取画布尺寸。 */
function readWebp(bytes: Uint8Array): SafeImageDimensions {
  assertRange(bytes, 12, 9);
  const subtype = ascii(bytes, 12, 4);
  if (subtype === 'VP8X') {
    assertRange(bytes, 24, 6);
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1, type: 'webp' };
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

/** 遍历 RIFF Chunk，识别 ANMF 与 EXIF，防止动画只按画布一次计像素。 */
function inspectWebp(bytes: Uint8Array, maximumUnits: number): SafeImageInspection {
  const primary = readWebp(bytes);
  assertRange(bytes, 0, 12);
  const riffEnd = checkedChunkLength(u32(bytes, 4, true), 8);
  if (riffEnd > bytes.byteLength) throw invalidImage('WebP RIFF 声明长度超过文件边界');
  let offset = 12;
  let animationFlag = false;
  let frameCount = 0;
  let orientation: number | null = null;
  let orientationInspectionComplete = true;
  while (offset < riffEnd) {
    assertRange(bytes, offset, 8);
    const type = ascii(bytes, offset, 4);
    const dataLength = u32(bytes, offset + 4, true);
    const paddedLength = checkedChunkLength(dataLength, dataLength % 2);
    const chunkLength = checkedChunkLength(paddedLength, 8);
    assertRange(bytes, offset, chunkLength);
    const dataOffset = offset + 8;
    if (type === 'VP8X') {
      if (dataLength < 10) throw invalidImage('WebP VP8X 长度非法');
      animationFlag = ((bytes[dataOffset] ?? 0) & 0x02) !== 0;
    } else if (type === 'ANMF') {
      if (dataLength < 16) throw invalidImage('WebP ANMF 长度非法');
      frameCount += 1;
      assertUnitCount(frameCount, maximumUnits);
    } else if (type === 'EXIF') {
      const payload = bytes.subarray(dataOffset, dataOffset + dataLength);
      const tiffPayload =
        payload.byteLength >= 6 && ascii(payload, 0, 6) === 'Exif\0\0'
          ? payload.subarray(6)
          : payload;
      const fact = tryReadExifOrientation(tiffPayload);
      orientation = fact.orientation;
      orientationInspectionComplete = fact.complete;
    }
    offset += chunkLength;
  }
  if (animationFlag && frameCount === 0) throw invalidImage('WebP 声明动画但缺少 ANMF');
  const unitCount = Math.max(1, frameCount);
  const animated = animationFlag || frameCount > 1;
  const units = Array.from({ length: unitCount }, () => ({
    width: primary.width,
    height: primary.height,
    orientation,
  }));
  return {
    ...primary,
    contentUnitKind: animated ? 'FRAME' : 'IMAGE',
    unitCount,
    animated,
    orientation,
    orientationInspectionComplete,
    storageOrder: null,
    units,
  };
}

/** 创建单图统一结果，减少各静态格式遗漏边界字段。 */
function staticInspection(
  primary: SafeImageDimensions,
  orientation: number | null,
  orientationInspectionComplete: boolean,
  storageOrder: SafeImageInspection['storageOrder'],
): SafeImageInspection {
  return {
    ...primary,
    contentUnitKind: 'IMAGE',
    unitCount: 1,
    animated: false,
    orientation,
    orientationInspectionComplete,
    storageOrder,
    units: [{ width: primary.width, height: primary.height, orientation }],
  };
}

/** EXIF 损坏不让可靠像素尺寸消失，但必须返回 complete=false 供调用方形成告警。 */
function tryReadExifOrientation(bytes: Uint8Array): {
  readonly orientation: number | null;
  readonly complete: boolean;
} {
  try {
    assertRange(bytes, 0, 8);
    const littleEndian = bytes[0] === 0x49;
    const valid = littleEndian
      ? bytes[1] === 0x49 && u16(bytes, 2, true) === 42
      : bytes[0] === 0x4d && bytes[1] === 0x4d && u16(bytes, 2, false) === 42;
    if (!valid) throw invalidImage('EXIF TIFF Header 非法');
    const ifdOffset = u32(bytes, 4, littleEndian);
    assertRange(bytes, ifdOffset, 2);
    const entryCount = u16(bytes, ifdOffset, littleEndian);
    const entriesOffset = ifdOffset + 2;
    assertRange(
      bytes,
      entriesOffset,
      checkedChunkLength(checkedProduct(entryCount, 12, 'EXIF IFD 溢出'), 4),
    );
    for (let index = 0; index < entryCount; index += 1) {
      const entryOffset = entriesOffset + index * 12;
      if (u16(bytes, entryOffset, littleEndian) !== 274) continue;
      const type = u16(bytes, entryOffset + 2, littleEndian);
      const count = u32(bytes, entryOffset + 4, littleEndian);
      if (type !== 3 || count !== 1) return { orientation: null, complete: false };
      const value = u16(bytes, entryOffset + 8, littleEndian);
      return value >= 1 && value <= 8
        ? { orientation: value, complete: true }
        : { orientation: null, complete: false };
    }
    return { orientation: null, complete: true };
  } catch {
    return { orientation: null, complete: false };
  }
}

/** GIF extension/image data 都是长度前缀 sub-block；0 长度终止。 */
function skipSubBlocks(bytes: Uint8Array, initialOffset: number): number {
  let offset = initialOffset;
  while (true) {
    assertRange(bytes, offset, 1);
    const length = bytes[offset] ?? 0;
    offset += 1;
    if (length === 0) return offset;
    assertRange(bytes, offset, length);
    offset += length;
  }
}

/** 统一校验首图或内容单元尺寸。 */
function assertDimensions(dimensions: { readonly width: number; readonly height: number }): void {
  if (
    !Number.isSafeInteger(dimensions.width) ||
    !Number.isSafeInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw invalidImage('图片尺寸不是有效正整数');
  }
}

/** 帧/页数量在继续增长前检查，避免恶意容器制造大数组。 */
function assertUnitCount(unitCount: number, maximumUnits: number): void {
  if (!Number.isSafeInteger(unitCount) || unitCount < 1 || unitCount > maximumUnits) {
    throw new DocumentParserError('IMAGE_UNIT_LIMIT_EXCEEDED', '图片页数或帧数超过安全上限');
  }
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
    !Number.isSafeInteger(length) ||
    length < 0 ||
    offset > bytes.byteLength - length
  ) {
    throw invalidImage('图片文件头或内容块被截断');
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

/** 小整数乘法先检查安全范围。 */
function checkedProduct(left: number, right: number, message: string): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    left > Math.floor(Number.MAX_SAFE_INTEGER / right)
  ) {
    throw invalidImage(message);
  }
  return left * right;
}

/** 两个非负长度相加前检查 Number 安全范围。 */
function checkedChunkLength(dataLength: number, overhead: number): number {
  if (
    !Number.isSafeInteger(dataLength) ||
    dataLength < 0 ||
    dataLength > Number.MAX_SAFE_INTEGER - overhead
  ) {
    throw invalidImage('图片内容块长度溢出');
  }
  return dataLength + overhead;
}

/** 检查配置和测试辅助入口的正整数。 */
function assertPositiveInteger(value: number, message: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidImage(message);
}

/** 图片结构错误使用稳定文档问题码，不泄漏第三方 Parser 文本。 */
function invalidImage(message: string): DocumentParserError {
  return new DocumentParserError('IMAGE_HEADER_INVALID', message);
}
