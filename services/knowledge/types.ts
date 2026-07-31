/**
 * 知识库服务类型
 *
 * Embedder = 只负责 text → vector（可缺省）
 * Retriever = keyword | hybrid（策略）
 * Scope = 本轮检索范围（与「是否必须绑一个文件」解耦）
 */

import type { KnowledgeChunk } from "../types";

export type KnowledgeScope =
  | { mode: "none" }
  | { mode: "documents"; documentIds: string[] }
  | { mode: "all" };

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
}

export interface SearchResult {
  chunk: KnowledgeChunk & { documentName?: string };
  score: number;
}

export interface VectorStore {
  insert(vectors: VectorDocument[]): Promise<void>;
  search(
    queryVector: Float32Array,
    options?: {
      topK?: number;
      scope?: Exclude<KnowledgeScope, { mode: "none" }>;
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
}

export interface RetrievalResult {
  chunks: RetrievalHit[];
  strategy: "keyword" | "hybrid";
}

export interface Retriever {
  retrieve(
    query: string,
    scope: KnowledgeScope,
    options?: { topK?: number },
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
