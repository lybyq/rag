/**
 * 文件安全策略把 Scanner 和 Parser inspection 事实合并成稳定结论。
 * 它不调用任何 Provider；所有异常数据都采用 fail-closed，避免“扫描失败等于安全”。
 *
 * @requirement PAR-002
 * @requirement PAR-003
 */
import type { FileSecurityVerdict, FileStructureInspection } from '@rag/contracts';

/** 安全限制来自配置快照，单位在字段名中明确。 */
export interface FileSecurityLimits {
  readonly maxArchiveDepth: number;
  readonly maxCompressionRatio: number;
  readonly maxPages: number;
  readonly maxTotalPixels: number;
  readonly maxTableCells: number;
}

/** 安全问题使用稳定代码，公开消息不包含正文或供应商响应。 */
export interface FileSecurityFinding {
  readonly severity: 'WARNING' | 'ERROR';
  readonly code: string;
  readonly message: string;
}

/** 安全策略结果；REJECTED 优先级高于 MANUAL_REVIEW。 */
export interface FileSecurityEvaluation {
  readonly verdict: FileSecurityVerdict;
  readonly findings: readonly FileSecurityFinding[];
}

/** Scanner 策略只需要稳定 verdict/signature 字段，便于领域测试不依赖 Adapter 细节。 */
export interface MalwareVerdictInput {
  readonly verdict: 'CLEAN' | 'INFECTED';
  readonly signatureName: string | null;
}

/** 对结构和恶意软件事实执行确定性门禁。 */
export function evaluateFileSecurity(
  inspection: FileStructureInspection,
  malware: MalwareVerdictInput,
  limits: FileSecurityLimits,
): FileSecurityEvaluation {
  const findings: FileSecurityFinding[] = [];
  const reject = (code: string, message: string): void => {
    findings.push({ severity: 'ERROR', code, message });
  };
  const warn = (code: string, message: string): void => {
    findings.push({ severity: 'WARNING', code, message });
  };

  if (malware.verdict === 'INFECTED') reject('MALWARE_DETECTED', '恶意软件扫描命中');
  if (inspection.encrypted) reject('PASSWORD_PROTECTED', '文件受密码保护，无法安全检查完整内容');
  if (inspection.hasMacros) reject('ACTIVE_MACRO', '文件包含活动宏');
  if (inspection.archiveDepth !== null && inspection.archiveDepth > limits.maxArchiveDepth) {
    reject('ARCHIVE_DEPTH_EXCEEDED', '压缩嵌套层数超过安全上限');
  }
  if (
    inspection.compressedSizeBytes !== null &&
    inspection.uncompressedSizeBytes !== null &&
    (inspection.compressedSizeBytes === 0
      ? inspection.uncompressedSizeBytes > 0
      : inspection.uncompressedSizeBytes / inspection.compressedSizeBytes >
        limits.maxCompressionRatio)
  ) {
    reject('COMPRESSION_RATIO_EXCEEDED', '解压比例超过安全上限');
  }
  if (inspection.pageCount !== null && inspection.pageCount > limits.maxPages) {
    reject('PAGE_LIMIT_EXCEEDED', '文档页数超过安全上限');
  }
  if (inspection.totalPixels !== null && inspection.totalPixels > limits.maxTotalPixels) {
    reject('PIXEL_LIMIT_EXCEEDED', '图片总像素超过安全上限');
  }
  if (inspection.tableCellCount !== null && inspection.tableCellCount > limits.maxTableCells) {
    reject('TABLE_CELL_LIMIT_EXCEEDED', '表格单元格数量超过安全上限');
  }
  if (inspection.embeddedObjectCount > 0) {
    warn('EMBEDDED_OBJECT_FOUND', '文件包含嵌入对象，需要人工确认');
  }
  if (inspection.externalLinkCount > 0) {
    warn('EXTERNAL_LINK_FOUND', '文件包含外部链接，需要人工确认');
  }

  return {
    verdict: findings.some((finding) => finding.severity === 'ERROR')
      ? 'REJECTED'
      : findings.length > 0
        ? 'MANUAL_REVIEW'
        : 'CLEAN',
    findings,
  };
}
