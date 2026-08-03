/**
 * 索引端口（Phase 0 契约；FTS5 / 可版本化 IndexBuild 在后续阶段接入）
 */

export interface IndexBuildRef {
  id: string;
  kind: "keyword" | "vector";
  model?: string;
  modelRevision?: string;
  dimension?: number;
  chunkStrategyVersion?: string;
  configHash?: string;
  status: "queued" | "running" | "ready" | "failed" | "superseded";
}

export interface IndexChunk {
  id: string;
  documentId: string;
  content: string;
  searchText?: string;
  metadata?: Record<string, unknown>;
}

export interface IndexCandidate {
  chunkId: string;
  score: number;
  documentId: string;
  /** 召回侧可附带正文，避免二次全量拉取 */
  content?: string;
  documentName?: string;
  pageNumber?: number;
  position?: number;
  source?: "library" | "conversation_file";
  revisionId?: string;
  processingBuildId?: string;
}

export interface KeywordQuery {
  /** 原始或规划后的查询文本（legacy 兼容） */
  text: string;
  /** QueryPlanner 词项；缺省由服务端 extractSearchTerms */
  terms?: string[];
  /** 完整短语意图；FTS 必须先 phrase，未命中再 AND，不得直接 OR。 */
  phrase?: string;
  exactTerms?: Array<{ value: string; kind?: string; weight?: number }>;
  languagePrimary?: string;
}

export interface KeywordSearchOptions {
  topK: number;
  candidateLimit?: number;
  spaceIds?: string[];
  documentIds?: string[];
  activeBuildIds?: string[];
  preferLegacy?: boolean;
}

export interface KeywordIndex {
  upsert(build: IndexBuildRef, chunks: IndexChunk[]): Promise<void>;
  search(
    query: string | KeywordQuery,
    options: KeywordSearchOptions,
  ): Promise<IndexCandidate[]>;
}

export interface EmbeddedChunk {
  chunkId: string;
  documentId: string;
  vector: Float32Array;
}

export interface VectorSearchOptions {
  topK: number;
  spaceIds?: string[];
  documentIds?: string[];
}

export interface VectorIndex {
  upsert(build: IndexBuildRef, vectors: EmbeddedChunk[]): Promise<void>;
  search(
    vector: Float32Array,
    options: VectorSearchOptions,
  ): Promise<IndexCandidate[]>;
}
