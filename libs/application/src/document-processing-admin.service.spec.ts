/** M03 管理查询授权测试。 */
import type {
  AccessContext,
  DocumentProcessingRepository,
  MalwareScannerPort,
  OcrPort,
  ParserPort,
} from '.';
import { createTestUserContext } from '@rag/testing';
import type { ProcessingProviderProfile } from '@rag/contracts';
import { DocumentProcessingAdminService } from './document-processing-admin.service';

function context(role: 'KNOWLEDGE_READER' | 'SYSTEM_ADMIN' | 'AUDITOR'): AccessContext {
  return { user: createTestUserContext('profile-reader', [role]), requestId: 'm03-admin-test' };
}

function profile(kind: 'MALWARE_SCANNER' | 'PARSER' | 'OCR'): ProcessingProviderProfile {
  return {
    kind,
    adapter: 'http',
    profileId: `${kind.toLowerCase()}-profile`,
    revision: 'r1',
    protocolVersion: '1',
    endpoint: 'http://provider.internal',
    capabilities: [],
    timeoutMs: 1_000,
  };
}

describe('DocumentProcessingAdminService', () => {
  const repository = {} as DocumentProcessingRepository;
  const scanner = { profile: () => profile('MALWARE_SCANNER') } as MalwareScannerPort;
  const parser = { profile: () => profile('PARSER') } as ParserPort;
  const ocr = { profile: () => profile('OCR') } as OcrPort;
  const service = new DocumentProcessingAdminService(repository, scanner, parser, ocr);

  it('[PAR-015] 普通知识读者不能读取 Provider 拓扑', () => {
    expect(() => service.listProfiles(context('KNOWLEDGE_READER'))).toThrow('仅系统管理员或审计员');
  });

  it('[PAR-015] 管理员读取的 Profile 不包含密钥', () => {
    const profiles = service.listProfiles(context('SYSTEM_ADMIN'));
    expect(profiles).toHaveLength(3);
    expect(JSON.stringify(profiles)).not.toContain('apiKey');
  });
});
