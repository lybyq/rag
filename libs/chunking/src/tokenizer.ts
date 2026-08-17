/**
 * M04 本地真实 BPE Tokenizer。
 * 它为 Chunk 上限提供确定性的 tokenCount，不使用字符数或固定比例估算；模型精确 Tokenizer 可通过同一接口替换。
 * 本文件不负责选择业务阈值，也不发起远程模型请求。
 *
 * @requirement KNO-007
 */
import { getEncoding } from 'js-tiktoken';
import type { TextTokenizer } from './types';

/** 使用固定 cl100k_base 词表的本地 Tokenizer。 */
export class Cl100kTextTokenizer implements TextTokenizer {
  public readonly profileId: string;
  public readonly revision = 'js-tiktoken-1.0.21:cl100k_base';
  private readonly encoding = getEncoding('cl100k_base');

  public constructor(profileId = 'cl100k-base-local') {
    this.profileId = profileId;
  }

  /** 返回真实 BPE token ID 数量。 */
  public count(text: string): number {
    return this.encoding.encode(text).length;
  }

  /**
   * 在 Token ID 层切分并解码，确保每段不超过上限。
   * overlap 只复用前一段末尾 Token，不按字符回退，因此中英文得到同一种预算语义。
   */
  public split(text: string, maxTokens: number, overlapTokens: number): readonly string[] {
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('maxTokens 必须为正整数');
    if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
      throw new Error('overlapTokens 必须大于等于 0 且小于 maxTokens');
    }
    const tokens = this.encoding.encode(text);
    if (tokens.length <= maxTokens) return [text];

    const chunks: string[] = [];
    const stride = maxTokens - overlapTokens;
    for (let start = 0; start < tokens.length; start += stride) {
      const decoded = this.encoding.decode(tokens.slice(start, start + maxTokens)).trim();
      if (decoded) chunks.push(decoded);
      if (start + maxTokens >= tokens.length) break;
    }
    return chunks;
  }
}
