# 内网 Provider HTTP 契约

本文是把项目带入内网前交给 LLM、Embedding、Reranker 和 OCR 服务团队的联调清单。生产代码仍以 `libs/contracts` 的 Zod Schema 为机器真相；本文负责用人能读懂的方式解释。

## 1. 通用要求

- 使用内网 HTTP/HTTPS，推荐由统一模型网关做鉴权、限流和证书。
- 请求携带 `Authorization: Bearer <key>` 时不得把 Key 写日志。
- 所有服务必须支持调用方断开；平台会通过 AbortSignal 取消 HTTP 请求。
- 429 和 5xx 可被有限重试；400/401/403、Schema 和版本错误不会重试。
- 除显式配置为纯文本的 OCR 外返回 JSON，错误正文不会被平台透传给用户。
- revision 必须代表不可变制品版本，不能写 `latest/current` 后又静默换模型。
- 日志不得记录完整文档、问题或证据正文。

## 2. LLM：OpenAI-compatible

当 `LLM_ADAPTER=openai-compatible` 时，平台调用：

```http
POST {LLM_BASE_URL}/chat/completions
Content-Type: application/json
Authorization: Bearer {LLM_API_KEY}
```

请求包含 `model`、`messages`、`temperature`、`max_tokens`，部分任务要求 JSON 输出。`LLM_JSON_MODE=response-format` 会发送 OpenAI JSON response format；若内网 vLLM 明确不支持该参数才改为 `prompt-only`，但响应仍会做严格 Schema 校验。响应至少满足：

```json
{
  "choices": [
    {
      "message": {
        "content": "{\"结构化字段\":\"由具体任务约定\"}",
        "reasoning_content": "可选推理文本，平台不会把它当答案或证据"
      },
      "finish_reason": "stop"
    }
  ]
}
```

平台会分别用于 Query Rewrite、Draft Generation、Evidence Rerank 和 Semantic Judge。三类答案任务分别使用 `LLM_GENERATION_MAX_OUTPUT_TOKENS`、`LLM_RERANK_MAX_OUTPUT_TOKENS`、`LLM_JUDGE_MAX_OUTPUT_TOKENS`。模型网关必须保持 JSON 字符串完整，不得自动追加解释或 Markdown Fence。`content=null` 且只有 `reasoning_content`、或 `finish_reason` 表示截断时，平台会分别报 Schema/Partial 错误，不会伪装成“证据不足”。

联调重点：模型 ID 是否存在、JSON 模式是否稳定、最大上下文、超时、并发、429、取消、中文数字与引用 ID 是否原样返回。

## 3. Embedding

### 3.1 健康与元数据

```http
GET {EMBEDDING_BASE_URL}/health
GET {EMBEDDING_BASE_URL}/metadata
```

`/health` 只要求 2xx。`/metadata` 示例：

```json
{
  "provider": "internal-model-platform",
  "modelId": "BAAI/bge-m3",
  "revision": "2026-08-approved-r1",
  "protocolVersion": "1",
  "tokenizerRevision": "bge-m3-tokenizer-r1",
  "denseDimension": 1024,
  "normalizeDense": true,
  "sparseFormatVersion": "bge-m3-sparse-v1",
  "maxInputTokens": 8192,
  "maxBatchSize": 32,
  "capabilities": ["query", "document", "dense", "sparse"]
}
```

这些值必须来自服务实际加载的模型。与 env 不一致时平台 fail-closed，避免错误维度污染 Milvus。

### 3.2 批量向量化

```http
POST {EMBEDDING_BASE_URL}/v1/embeddings
Content-Type: application/json
```

```json
{
  "protocolVersion": "1",
  "modelId": "BAAI/bge-m3",
  "purpose": "DOCUMENT",
  "inputs": [
    {
      "itemId": "chunk-id",
      "contentSha256": "64位小写十六进制",
      "text": "待向量化文本"
    }
  ]
}
```

`purpose` 是 `DOCUMENT` 或 `QUERY`，服务应应用已版本化的不同模板。返回允许部分成功：

```json
{
  "outputs": [
    {
      "itemId": "chunk-id",
      "contentSha256": "与输入一致",
      "dense": [0.01, -0.02],
      "sparse": { "indices": [12, 99], "values": [0.8, 0.3] },
      "modelId": "BAAI/bge-m3",
      "revision": "2026-08-approved-r1"
    }
  ],
  "failures": []
}
```

Dense 数量必须等于配置维度；Sparse indices 必须严格递增且与 values 等长；每个 itemId 只能出现一次。失败项必须返回稳定 code、retryable 和脱敏 publicMessage。

## 4. Reranker

### 4.1 健康与元数据

```http
GET {RERANKER_BASE_URL}/health
GET {RERANKER_BASE_URL}/v1/metadata
```

```json
{
  "provider": "internal-model-platform",
  "modelId": "BAAI/bge-reranker-v2-m3",
  "revision": "2026-08-approved-r1",
  "protocolVersion": "1",
  "maximumCandidates": 50,
  "maximumInputTokens": 8192
}
```

### 4.2 排序

```http
POST {RERANKER_BASE_URL}/v1/rerank
Content-Type: application/json
```

```json
{
  "protocolVersion": "1",
  "modelId": "BAAI/bge-reranker-v2-m3",
  "revision": "2026-08-approved-r1",
  "query": "差旅 6000 元需要谁审批？",
  "documents": [{ "candidateId": "c1", "title": "差旅制度", "content": "..." }],
  "topN": 10
}
```

返回：

```json
{
  "protocolVersion": "1",
  "modelId": "BAAI/bge-reranker-v2-m3",
  "revision": "2026-08-approved-r1",
  "scores": [{ "candidateId": "c1", "score": 0.96, "rank": 1 }]
}
```

必须恰好返回 `min(topN, documents.length)` 个不重复且来自输入的 candidateId，`rank` 必须恰好覆盖 1～N，响应数组可以乱序。不能漏一半让平台误以为“低分”，部分结果属于契约错误。

`RERANKER_SCORE_TYPE=probability` 表示服务已经返回 0～1 分数，越界会拒绝；`logit` 表示原始实数分数，Adapter 会且只会做一次 Sigmoid。这个值填错会直接扭曲证据阈值，不能靠“看起来差不多”决定。

## 5. OCR

```http
POST {OCR_BASE_URL}/v1/ocr
Content-Type: application/json
```

请求只包含短时源对象和明确目标，不发送永久 MinIO 凭据：

```json
{
  "protocolVersion": "2",
  "source": {
    "url": "短时预签名GET URL",
    "fileName": "policy.pdf",
    "format": "PDF",
    "declaredMime": "application/pdf"
  },
  "targets": [
    {
      "targetId": "page-3",
      "kind": "PAGE",
      "pageNo": 3,
      "slideNo": null,
      "sheetName": null,
      "bbox": null,
      "assetRef": null,
      "reason": "LOW_TEXT_COVERAGE"
    }
  ]
}
```

`OCR_RESPONSE_FORMAT=platform-json` 时响应：

```json
{
  "engine": "PaddleOCR",
  "engineRevision": "必须等于 OCR_REVISION",
  "protocolVersion": "2",
  "results": [
    {
      "targetId": "page-3",
      "pageNo": 3,
      "averageConfidence": 0.93,
      "blocks": [
        {
          "type": "PARAGRAPH",
          "text": "识别文本",
          "originalText": "识别文本",
          "pageNo": 3,
          "sheetName": null,
          "slideNo": null,
          "bbox": { "x1": 0.1, "y1": 0.2, "x2": 0.8, "y2": 0.3 },
          "headingLevel": null,
          "confidence": 0.93,
          "table": null,
          "metadata": {}
        }
      ]
    }
  ],
  "durationMs": 328,
  "warnings": []
}
```

OCR 只能返回调用方请求过的 targetId。bbox 归一化为左上原点的 0～1 坐标。表格应返回二维 rows、headerRowCount 和 mergedCells，而不是把表格粗暴拼成一行。

内网服务只返回整段文本时，可显式选择以下模式，不能由平台无界猜测：

- `text`：HTTP body 就是纯文本；
- `json-string`：HTTP body 是 JSON 字符串，例如 `"识别正文"`；
- `json-text-field`：HTTP body 是 JSON 对象，正文位于 `OCR_JSON_TEXT_FIELD` 指定的顶层字段。

纯文本模式一次请求只能有一个 target。目标页/图片身份沿用请求事实；bbox、置信度保持 `null`，系统会产生“置信度不可用”告警而不是伪造 0 或 1。空白、HTML 错误页以及把整份多页文本复制给多个目标都会被拒绝。上述配置只解决响应形状，真实请求究竟是预签名 URL、文件还是 Base64，仍必须拿内网脱敏抓包确认。

## 6. 项目自带 Parser

```http
POST http://document-parser-service:8104/v1/parse
```

请求：

```json
{
  "protocolVersion": "2",
  "source": {
    "url": "短时预签名GET URL",
    "fileName": "policy.docx",
    "format": "DOCX",
    "declaredMime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }
}
```

Parser 返回统一 blocks、pages、ocrCandidates、inspection、durationMs 和 warnings。内网通常无需替换它；只有新增供应商格式或公司已有解析平台时才实现新的 Parser Adapter。

## 7. 上线前最小契约验收

每个 Provider 都要覆盖：正常、超时、调用方取消、错误 Schema、401/403、429、5xx、版本不匹配和部分失败。再使用一小套批准脱敏样本做语义验收：

- Embedding：同义问题召回、专有名词、数字、否定句、中英混合。
- Reranker：强相关排在弱相关前，候选多时不超时。
- OCR：扫描 PDF、旋转页、表格、低清图、中英文、空白页。
- LLM：严格 JSON、引用 ID、拒答、冲突证据、长上下文和取消。

协议测试通过只说明“能合作”，Golden 指标通过才说明“效果能上线”。
