/**
 * 知识库服务类型
 *
 * Embedder = 只负责 text → vector（可缺省）
 * Retriever = keyword | hybrid（策略）
 * Scope = 本轮检索范围（双命名空间：资料库 + 会话附件）
 */

import type { KnowledgeChunk } from "../types";

/**
 * 旧版 scope（仅 library）。仅供 normalizeRetrievalScope 入参兼容；
 * 新代码请使用 RetrievalScope。
 */
export type KnowledgeScope =
  | { mode: "none" }
  | { mode: "documents"; documentIds: string[] }
  | { mode: "all" };

/**
 * 统一检索范围：资料库与会话附件可并存。
 * chat / Retriever 的唯一 scope 类型。
 */
export type RetrievalScope =
  | { mode: "none" }
  | {
      mode: "sources";
      library?: { documentIds: string[] } | "all";
      /** 必须带 conversationId，服务端按归属过滤，禁止跨会话用 fileId 捞片段 */
      conversationFiles?: { conversationId: string; fileIds: string[] };
    };

export type DocumentNamespace = "library" | "conversation";

export interface Embedder {
  readonly dimension: number;
  readonly modelName: string;
  isAvailable(): Promise<boolean>;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export interface VectorDocument {
  id: string;
  documentId: string;
  vector: Float32Array;
  metadata: {
    pageNumber: number;
    position: number;
    content: string;
  };
  namespace?: DocumentNamespace;
}

export interface SearchResult {
  chunk: KnowledgeChunk & {
    documentName?: string;
    source?: "library" | "conversation_file";
  };
  score: number;
}

export interface VectorStore {
  insert(vectors: VectorDocument[]): Promise<void>;
  search(
    queryVector: Float32Array,
    options?: {
      topK?: number;
      scope?: Exclude<RetrievalScope, { mode: "none" }>;
    },
  ): Promise<SearchResult[]>;
}

export interface RetrievalHit {
  id: string;
  documentId: string;
  documentName: string;
  pageNumber: number;
  position: number;
  content: string;
  score: number;
  source: "library" | "conversation_file";
  /** 有 IndexBuild 时由 data-service 附带；否则 citations 用 legacy */
  revisionId?: string;
  processingBuildId?: string;
  /** 摄取时附带的精确定位；缺省由 Context Builder 推断 */
  locatorHint?: import("./core/types").CitationLocator;
  /** OCR block 归一化 bbox：[x, y, width, height]，0..1 */
  bbox?: [number, number, number, number];
  /** 跨分散区域时省略 bbox，诊断标记 */
  bboxDegraded?: boolean;
  headingPath?: string[];
  startLine?: number;
  endLine?: number;
  startOffset?: number;
  endOffset?: number;
}

export interface RetrievalResult {
  chunks: RetrievalHit[];
  strategy: "keyword" | "hybrid";
}

export interface Retriever {
  retrieve(
    query: string,
    scope: RetrievalScope,
    options?: {
      topK?: number;
      preferKeyword?: boolean;
      keywordQuery?: import("./ports/indexes").KeywordQuery;
    },
  ): Promise<RetrievalResult>;
}

export interface ChunkerConfig {
  maxChunkSize: number;
  minChunkSize: number;
  overlapSize: number;
  separators: string[];
}

export interface ParsedPage {
  pageNumber: number;
  text: string;
}

export interface ParsedDocument {
  pageCount: number;
  pages: ParsedPage[];
}
