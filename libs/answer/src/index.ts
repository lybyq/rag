/** 基于证据的答案校验和最终化纯业务规则公共出口。 */
export const ANSWER_BOUNDARY = 'answer' as const;
export * from './answer-validator';
export * from './final-answer';
