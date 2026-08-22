/**
 * Node 多格式 Parser Core 公共出口。
 * 组装层通过工厂获得完整 Registry；格式实现仍保持独立文件，方便 Golden 测试和替换算法。
 *
 * @requirement PAR-005
 * @requirement PAR-006
 */
import {
  CsvDocumentParser,
  HtmlDocumentParser,
  MarkdownDocumentParser,
  TextDocumentParser,
} from './textual.parsers';
import { DocxDocumentParser } from './docx.parser';
import { ImageDocumentParser } from './image.parser';
import { ParserRegistry, type ParserRegistryIdentity } from './parser-registry';
import { PdfDocumentParser } from './pdf.parser';
import type { DocumentParserLimits } from './types';
import { XlsxDocumentParser } from './xlsx.parser';
import { PptxDocumentParser } from './pptx.parser';

/** 创建具备全部首批格式能力的 Parser Registry。 */
export function createDocumentParserRegistry(
  limits: DocumentParserLimits,
  identity: ParserRegistryIdentity,
): ParserRegistry {
  return new ParserRegistry(
    [
      new PdfDocumentParser(),
      new DocxDocumentParser(),
      new XlsxDocumentParser(),
      new PptxDocumentParser(),
      new ImageDocumentParser(),
      new HtmlDocumentParser(),
      new MarkdownDocumentParser(),
      new TextDocumentParser(),
      new CsvDocumentParser(),
    ],
    limits,
    identity,
  );
}

export * from './docx.parser';
export * from './html-structure';
export * from './image.parser';
export * from './parser-registry';
export * from './pdf.parser';
export * from './pptx.parser';
export * from './safe-ooxml';
export * from './textual.parsers';
export * from './types';
export * from './image-dimensions';
export * from './xlsx.parser';
