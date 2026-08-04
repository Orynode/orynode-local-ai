/**
 * Knowledge Engine 稳定领域 DTO（Phase 0）
 *
 * 完整 Revision / ProcessingBuild / IndexBuild 表结构在 Phase 2 落地；
 * 此处先定义对外契约，现有实现通过 legacy 适配器填充占位字段。
 */

import type { RetrievalHit, RetrievalScope } from "../types";

export type KnowledgeSpaceKind = "library" | "conversation" | "agent";

export interface KnowledgeSpace {
  id: string;
  kind: KnowledgeSpaceKind;
  ownerRef?: string;
  lifecycle: "persistent" | "scoped";
}

export type CitationLocator =
  | {
      kind: "page";
      page: number;
      bbox?: [number, number, number, number];
      /** 页内字符范围（可选） */
      startOffset?: number;
      endOffset?: number;
    }
  | {
      kind: "markdown";
      headingPath?: string[];
      startLine?: number;
      endLine?: number;
    }
  | { kind: "web"; url: string; headingPath?: string[]; selector?: string; textFragment?: string }
  | {
      kind: "code";
      repo: string;
      path: string;
      commit: string;
      startLine: number;
      endLine: number;
    }
  | { kind: "text"; startOffset: number; endOffset: number };

export interface Citation {
  id: string;
  documentId: string;
  /** 稳定 chunk 主键；Agent open / resolveCitation 使用此字段 */
  chunkId: string;
  /**
   * 版本 id：有 IndexBuild/revision 时为真实 id；
   * 尚无版本行时为 "legacy"（expand 阶段占位，非永久设计）
   */
  revisionId: string;
  processingBuildId: string;
  title: string;
  sourceType: string;
  uri?: string;
  locator: CitationLocator;
  excerpt: string;
}

export interface RetrievalDiagnostics {
  strategy: string[];
  candidateCount: number;
  elapsedMs: number;
  degradedCapabilities: string[];
  /** 稳定降级原因码 */
  degradedReasons?: string[];
  requestedTier?: "auto" | "lite" | "balanced" | "quality";
  effectiveTier?: "lite" | "balanced" | "quality";
  /** 稳定 pipeline 阶段名，便于评测与调试 */
  pipeline?: string[];
  /** 查询语言主标签（ML diagnostics） */
  queryLanguage?: string;
  variants?: Array<{ kind: string; language: string; weight: number }>;
  fusion?: "none" | "weighted_rrf" | "keyword_only" | "vector_only";
  activeKeywordBuild?: string;
  activeVectorBuild?: string;
  embeddingModel?: string;
  embeddingArtifactRole?: string;
}

export interface RetrievalRequest {
  query: string;
  scope: RetrievalScope;
  topK?: number;
  /** Chat 绑定会话附件归属时传入；客户端声明不可信 */
  conversationId?: string | null;
  /** 检索档位；缺省读 runtime-settings */
  knowledgeTier?: "auto" | "lite" | "balanced" | "quality";
}

export interface RetrievalResponse {
  query: string;
  rewrittenQueries: string[];
  hits: RetrievalHit[];
  citations: Citation[];
  diagnostics: RetrievalDiagnostics;
  /** 与 search 同源生成；可选透传给需要高亮的消费者 */
  highlightTerms?: string[];
}

/** Chat 从模型窗口拆出的独立预算 */
export type ContextBudget = {
  modelContextTokens: number;
  outputReserveTokens: number;
  historyBudgetTokens: number;
  knowledgeBudgetTokens: number;
  safetyMarginTokens: number;
};

export interface ContextRequest {
  hits: RetrievalHit[];
  /** 预分配的 citation 列表；缺省时由 buildContext 从 hits 生成 */
  citations?: Citation[];
  /** 知识上下文独立 token 预算；缺省不截断装箱 */
  maxTokens?: number;
  /** 是否扩展同 Revision 邻块；默认 true */
  expandNeighbors?: boolean;
  /** 胶囊摘录定位词（通常为 highlightTerms） */
  excerptTerms?: string[];
}

export interface ContextPackage {
  text: string;
  citations: Citation[];
  tokenEstimate: number;
  /** 无精确 tokenizer 时为 true */
  approximateTokens?: boolean;
}

export interface SearchRequest {
  query: string;
  scope: RetrievalScope;
  topK?: number;
  conversationId?: string | null;
  knowledgeTier?: "auto" | "lite" | "balanced" | "quality";
}

export interface SearchResponse {
  query: string;
  hits: RetrievalHit[];
  diagnostics: RetrievalDiagnostics;
  /**
   * Search 一等字段：供工作台/Agent 高亮（含简繁与跨语言提示）。
   * 由 Engine 生成；客户端缺省时可回退为从 query 抽取。
   */
  highlightTerms?: string[];
}

export interface IngestCommand {
  target: "library" | "conversation";
  bytes: ArrayBuffer;
  fileName: string;
  displayName?: string | null;
  conversationId?: string;
}

export interface IngestReceipt {
  documentId: string;
  namespace: "library" | "conversation";
  status: string;
  reused?: boolean;
}

export interface ResolvedCitation {
  citation: Citation;
  available: boolean;
  reason?: "deleted" | "unavailable";
}

/** Phase 0 占位：尚未有真实 revision/build 时使用 */
export const LEGACY_REVISION_ID = "legacy";
export const LEGACY_PROCESSING_BUILD_ID = "legacy";

export interface DocumentRevisionRef {
  id: string;
  documentId: string;
  contentHash: string;
  createdAt: string;
}

export interface ChunkSetRef {
  id: string;
  revisionId: string;
  strategyVersion: string;
  configHash: string;
  status: "queued" | "running" | "ready" | "failed";
}

export interface IndexBuildRef {
  id: string;
  chunkSetId: string;
  kind: "keyword" | "vector";
  model?: string | null;
  dimension?: number | null;
  configHash: string;
  status: "queued" | "running" | "ready" | "failed" | "superseded";
  isActive: boolean;
}
