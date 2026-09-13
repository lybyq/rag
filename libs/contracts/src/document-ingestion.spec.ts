/** OPT-013：外部批次长期身份、内容 Hash 与请求幂等契约测试。 */
import {
  CreateDocumentBatchRequestSchema,
  DocumentBatchFileStatusSchema,
} from './document-ingestion';

describe('[OPT-013] 外部文档批次 contracts', () => {
  test('长期外部身份和 SHA-256 必须同时提供', () => {
    const valid = {
      files: [
        {
          clientFileId: 'client-1',
          externalSourceId: 'finance-system',
          externalDocumentId: 'travel-policy',
          originalFileName: '差旅制度.pdf',
          sizeBytes: 1024,
          contentType: 'application/pdf',
          sha256: 'a'.repeat(64),
        },
      ],
    };
    expect(CreateDocumentBatchRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      CreateDocumentBatchRequestSchema.safeParse({
        files: [{ ...valid.files[0], externalDocumentId: undefined }],
      }).success,
    ).toBe(false);
    expect(
      CreateDocumentBatchRequestSchema.safeParse({
        files: [{ ...valid.files[0], sha256: undefined }],
      }).success,
    ).toBe(false);
  });

  test('未完成上传必须用 null 表达尚无 Job，不能制造假进度', () => {
    expect(
      DocumentBatchFileStatusSchema.safeParse({
        fileId: '0198a8f4-12f8-7000-8000-111111111111',
        clientFileId: 'client-1',
        externalSourceId: 'finance-system',
        externalDocumentId: 'travel-policy',
        originalFileName: '差旅制度.pdf',
        uploadStatus: 'PENDING',
        documentId: null,
        documentVersionId: null,
        jobId: null,
        jobStatus: null,
        currentStep: null,
        overallPercent: null,
        publicMessage: null,
      }).success,
    ).toBe(true);
  });
});
