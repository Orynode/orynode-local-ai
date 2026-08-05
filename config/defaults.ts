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
  knowledgeTier:
    runtimeDefaults.knowledgeTier === "auto" ||
    runtimeDefaults.knowledgeTier === "balanced" ||
    runtimeDefaults.knowledgeTier === "quality" ||
    runtimeDefaults.knowledgeTier === "lite"
      ? runtimeDefaults.knowledgeTier
      : "auto",
  ocrMode: runtimeDefaults.ocrMode === "disabled" ? "disabled" : "auto",
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

/**
 * 知识库 / RAG 配置
 *
 * 检索策略由单一用户叙事驱动：Settings.knowledgeTier。
 * - auto（默认）：按主机能力选择 Balanced 或 Lite
 * - lite：仅关键词（省资源）
 * - balanced / quality：在主机已加载向量模型时融合语义（quality 另加多查询/重排）
 *
 * ORYNODE_SEMANTIC_SEARCH 是主机资源开关（是否加载 embedding 模型），
 * 不是普通用户必配项。未开启时 auto/balanced/quality 自动降级并写诊断码。
 */
export const SEARCH_CONFIG = {
  topK: 8,
  maxSearchTerms: 40,
  /** Quality 档：规则多查询变体上限（不含原句） */
  multiQueryVariants: 2,
  /**
   * 关键词 0 命中时，纯向量召回的最低余弦阈值（E5 归一化后）。
   * 低于此值视为无答案噪声，不返回列表；displayName 不参与召回或豁免。
   */
  minVectorCosineSolo: 0.85,
  /**
   * 主机是否启用向量模型加载（data-service）。
   * 与 knowledgeTier 配合：档位请求语义 + 本开关为真 → 才走 hybrid。
   */
  semanticSearchEnabled:
    process.env.ORYNODE_SEMANTIC_SEARCH === "1" ||
    process.env.ORYNODE_SEMANTIC_SEARCH === "true",
};

export type KnowledgeTier = "auto" | "lite" | "balanced" | "quality";

/** 档位是否可能请求语义向量（仍受主机 ORYNODE_SEMANTIC_SEARCH / Runtime 约束） */
export function tierRequestsEmbedding(tier: KnowledgeTier): boolean {
  return (
    tier === "auto" || tier === "balanced" || tier === "quality"
  );
}

export function parseKnowledgeTier(value: unknown): KnowledgeTier | null {
  if (
    value === "auto" ||
    value === "lite" ||
    value === "balanced" ||
    value === "quality"
  ) {
    return value;
  }
  return null;
}

/** Agent space 默认配额（会话级，不入库） */
export const AGENT_SPACE_DEFAULTS = {
  maxDocuments: 32,
  maxOpenChunks: 8,
  ttlHours: 24,
};

import {
  resolveEmbeddingArtifact,
  type EmbeddingArtifact,
} from "./embedding-artifacts";

const resolvedEmbedding = resolveEmbeddingArtifact();

export const EMBEDDING_CONFIG = {
  artifactId: resolvedEmbedding.artifact.id,
  modelName: resolvedEmbedding.artifact.id,
  xenovaModelId: resolvedEmbedding.artifact.xenovaModelId,
  modelRevision: resolvedEmbedding.artifact.revision,
  dimension: resolvedEmbedding.artifact.dimension,
  batchSize: resolvedEmbedding.artifact.batchSize,
  role: resolvedEmbedding.artifact.role as EmbeddingArtifact["role"],
  queryTemplate: resolvedEmbedding.artifact.queryTemplate,
  passageTemplate: resolvedEmbedding.artifact.passageTemplate,
  maxInputChars: resolvedEmbedding.artifact.maxInputChars,
};

export {
  DEFAULT_EMBEDDING_ARTIFACT_ID,
  COMPAT_BASELINE_ARTIFACT_ID,
  EMBEDDING_ARTIFACTS,
  applyEmbeddingTemplate,
  embeddingConfigFingerprint,
  getEmbeddingArtifact,
  getRecommendedEmbeddingArtifact,
  isEmbeddingBuildCompatible,
  listEmbeddingArtifacts,
  resolveEmbeddingArtifact,
} from "./embedding-artifacts";
export type {
  EmbeddingArtifact,
  EmbeddingArtifactRole,
} from "./embedding-artifacts";

/**
 * OCR 首版安全上限（§16.5）；真实 Mac 基准后可调并记 ADR。
 * 与 knowledgeTier 解耦；用户开关见 RuntimeSettings.ocrMode。
 */
export const OCR_CONFIG = {
  minMeaningfulCharacters: 24,
  maxReplacementCharacterRatio: 0.3,
  renderDpi: 144,
  maxRenderedLongEdge: 2400,
  maxRenderedPixels: 16_000_000,
  maxOcrPagesPerDocument: 100,
  ocrPageConcurrency: 1,
  ocrPageTimeoutMs: 30_000,
  /** 单 block / 单页文本上限，防 helper 撑爆 SQLite / Prompt */
  maxBlockTextChars: 8_000,
  maxPageTextChars: 100_000,
  helperProtocolVersion: 1,
  /**
   * Apple Vision：fast 对中文扫描页常产出乱码；accurate 慢一些但可用。
   * 本机资料库默认 accurate。
   */
  recognitionLevel: "accurate" as "fast" | "accurate",
} as const;

export type OcrMode = "auto" | "disabled";


/**
 * 访问模式类型（解析请用 services/platform/access.resolveAccessMode）
 * - local_only（默认）：Web 仅绑定 127.0.0.1
 * - trusted_lan：绑定局域网；默认要求 pairing session
 * - ORYNODE_TRUSTED_LAN_UNSAFE=1：无认证预览（不得当作安全共享）
 */
export type AccessMode = "local_only" | "trusted_lan";

// ============================================================
// 文件上传限制
// ============================================================

/** 单文件上传上限（高清少页 PDF 可能很大；解析另有页数/OCR 资源上限） */
export const MAX_KNOWLEDGE_FILE_SIZE = 150 * 1024 * 1024; // 150 MB
export const MAX_KNOWLEDGE_FILE_SIZE_LABEL = "150 MB";

/** 文本内嵌预览最大读取字节（超出截断） */
export const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** 超过此大小预览时提示可能较慢（仍允许打开） */
export const PREVIEW_SIZE_WARN_BYTES = 40 * 1024 * 1024;
/** 小 PDF 整包进内存再交给 pdf.js 的上限；更大则走 URL 流式加载 */
export const PREVIEW_PDF_BUFFER_MAX_BYTES = 16 * 1024 * 1024;

// ============================================================
// HTTP 超时
// ============================================================

export const HTTP_TIMEOUT = {
  status: 1200,
  /** 列表/状态：向量重建时 data-service 可能短暂忙，不宜过短 */
  knowledge: 15_000,
  /** 原件预览 / 大文件字节拉取 */
  knowledgeFile: 2 * 60 * 1000,
  knowledgeImport: 2 * 60 * 1000,
  embeddingStatus: 8000,
  embedding: 10 * 60 * 1000,
  chat: 10 * 60 * 1000,
  settings: 3000,
  conversation: 3000,
};

/**
 * 查询改写：未命中术语库时用本地 LLM，成功后写入 SQLite，下次跳过。
 * ORYNODE_QUERY_REWRITE_LLM=0 关闭。
 */
export const QUERY_REWRITE_LLM_ENABLED =
  process.env.ORYNODE_QUERY_REWRITE_LLM !== "0" &&
  process.env.ORYNODE_QUERY_REWRITE_LLM !== "false";
