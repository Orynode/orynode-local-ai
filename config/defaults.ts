/**
 * 项目默认配置值
 * 运行时参数默认值见 config/runtime-defaults.json（与 data-service / start-turbo 共用）
 */

import type { RuntimeSettings } from "../services/types";
import runtimeDefaults from "./runtime-defaults.json";

// ============================================================
// 服务端口 & 地址
// ============================================================

export const TURBO_FIELDFARE_URL =
  process.env.TURBO_FIELDFARE_URL ?? "http://127.0.0.1:8080/v1";

export const ORYNODE_DATA_URL =
  process.env.ORYNODE_DATA_URL ?? "http://127.0.0.1:4318";

/** 公开源码仓库（界面「关于 / GitHub」入口） */
export const GITHUB_REPO_URL = "https://github.com/Orynode/orynode-local-ai";

export const EXPECTED_MODEL_ID = "gemma-4-26b-a4b-it";

export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "gemma-4-26b-a4b-it": "Gemma 4 26B A4B IT",
};

export function modelDisplayName(modelId: string): string {
  return MODEL_DISPLAY_NAMES[modelId] ?? modelId;
}

// ============================================================
// 默认运行时设置（与 config/runtime-defaults.json 同源）
// ============================================================

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  temperature: runtimeDefaults.temperature,
  topP: runtimeDefaults.topP,
  topK: runtimeDefaults.topK,
  maxContext: runtimeDefaults.maxContext,
  maxTokens: runtimeDefaults.maxTokens,
};

export const ALLOWED_MAX_CONTEXT = new Set(runtimeDefaults.allowedMaxContext);

// ============================================================
// 知识库 / RAG 配置
// ============================================================

export const CHUNK_CONFIG = {
  maxChunkSize: 1800,
  minChunkSize: 200,
  overlapSize: 200,
  separators: ["\n\n", "\n", "。", "！", "？", ".", "!", "?", "，", ";", " "],
};

export const SEARCH_CONFIG = {
  topK: 8,
  maxSearchTerms: 40,
  /**
   * 语义向量为可选能力。
   * false（默认）：仅 keyword。
   * true：data-service 加载 Xenova/bge-small-zh-v1.5；失败回退 keyword。
   */
  semanticSearchEnabled:
    process.env.ORYNODE_SEMANTIC_SEARCH === "1" ||
    process.env.ORYNODE_SEMANTIC_SEARCH === "true",
};

export const EMBEDDING_CONFIG = {
  modelName: "bge-small-zh-v1.5",
  dimension: 512,
  batchSize: 8,
};

// ============================================================
// 文件上传限制
// ============================================================

export const MAX_KNOWLEDGE_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
/** @deprecated 使用 MAX_KNOWLEDGE_FILE_SIZE */
export const MAX_PDF_SIZE = MAX_KNOWLEDGE_FILE_SIZE;

// ============================================================
// HTTP 超时
// ============================================================

export const HTTP_TIMEOUT = {
  status: 1200,
  knowledge: 5000,
  knowledgeImport: 2 * 60 * 1000,
  embeddingStatus: 8000,
  embedding: 10 * 60 * 1000,
  chat: 10 * 60 * 1000,
  settings: 3000,
  conversation: 3000,
};
