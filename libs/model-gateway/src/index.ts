/** LLM、Embedding、Reranker 和 OCR Provider Adapter 公共出口。 */
export const MODEL_GATEWAY_BOUNDARY = 'model-gateway' as const;
export * from './embedding-gateway.module';
export * from './fixture-embedding.adapter';
export * from './http-embedding.adapter';
