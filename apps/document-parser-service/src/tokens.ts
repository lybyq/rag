/**
 * Parser Service 依赖注入 Token。
 * 使用显式 Symbol 防止运行时把 TypeScript 类型擦除后误注入其他对象。
 *
 * @requirement PAR-005
 */

/** 完整多格式 Parser Registry 的唯一注入标识。 */
export const DOCUMENT_PARSER_REGISTRY = Symbol('DOCUMENT_PARSER_REGISTRY');
