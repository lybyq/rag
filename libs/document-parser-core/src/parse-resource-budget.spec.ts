/**
 * Parser 资源预算回归：只用极小阈值触发边界，不创建真正的大文件或消耗机器内存。
 *
 * @requirement PAR-017
 */
import { createDocumentParserRegistry, ParseResourceBudget } from './index';
import type { DocumentParserLimits } from './types';

const limits: DocumentParserLimits = {
  maxArchiveDepth: 3,
  maxCompressionRatio: 100,
  maxPages: 10,
  maxTotalPixels: 1_000,
  maxTableCells: 4,
  maxExpandedTableCells: 8,
  maxTableRows: 2,
  maxTableColumns: 20,
  maxTableSpan: 100,
  maxOutputCharacters: 20,
  maxInputBytes: 10_000,
  maxArchiveEntries: 100,
  maxXmlEntryBytes: 1_024 * 1_024,
};

describe('[PAR-017] parser resource budget', () => {
  it('在跨度占位分配前拒绝展开单元格超限，并保护安全整数乘法', () => {
    const budget = new ParseResourceBudget(limits, new AbortController().signal);
    expect(() => budget.consumeTableCells(1, 9)).toThrow(
      expect.objectContaining({ code: 'TABLE_EXPANDED_CELL_LIMIT_EXCEEDED' }),
    );
    expect(() => budget.assertTableSpan(Number.MAX_SAFE_INTEGER, 2)).toThrow(
      expect.objectContaining({ code: 'TABLE_SPAN_LIMIT_EXCEEDED' }),
    );
  });

  it('HTML 合并跨度在 occupied 占位展开前失败', async () => {
    const registry = createDocumentParserRegistry(limits, {
      revision: 'budget-r1',
      protocolVersion: '2',
    });
    await expect(
      registry.parse(
        {
          bytes: Buffer.from('<table><tr><td colspan="9">A</td></tr></table>'),
          fileName: 'span.html',
          format: 'HTML',
          declaredMime: 'text/html',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'TABLE_EXPANDED_CELL_LIMIT_EXCEEDED' });
  });

  it('CSV 在消费记录时累计真实单元格，而不是完整物化后才检查', async () => {
    const registry = createDocumentParserRegistry(limits, {
      revision: 'budget-r1',
      protocolVersion: '2',
    });
    await expect(
      registry.parse(
        {
          bytes: Buffer.from('a,b\nc,d\ne,f'),
          fileName: 'rows.csv',
          format: 'CSV',
          declaredMime: 'text/csv',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'TABLE_ROW_LIMIT_EXCEEDED' });
  });

  it('正文输出超限和调用前取消都使用稳定错误边界', async () => {
    const registry = createDocumentParserRegistry(limits, {
      revision: 'budget-r1',
      protocolVersion: '2',
    });
    await expect(
      registry.parse(
        {
          bytes: Buffer.from('这是一个超过二十个字符的纯文本段落，用于验证输出预算。'),
          fileName: 'large.txt',
          format: 'TEXT',
          declaredMime: 'text/plain',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PARSER_OUTPUT_LIMIT_EXCEEDED' });

    const controller = new AbortController();
    controller.abort(new Error('cancel-before-html'));
    await expect(
      registry.parse(
        {
          bytes: Buffer.from('<p>正文</p>'),
          fileName: 'cancel.html',
          format: 'HTML',
          declaredMime: 'text/html',
        },
        controller.signal,
      ),
    ).rejects.toThrow('cancel-before-html');
  });
});
