/**
 * 混合检索器（唯一检索入口）
 *
 * 经 KeywordIndex / VectorIndex adapters（默认 FTS5 + BLOB），
 * 不再在本文件直接拼 data-service HTTP。
 */

import type {
  Embedder,
  KnowledgeScope,
  RetrievalHit,
  RetrievalResult,
  RetrievalScope,
  Retriever,
} from "./types";
import { resolveEmbedder } from "./embedder";
import { SEARCH_CONFIG, ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../config/defaults";
import {
  extractSearchTerms,
  keywordScore,
  rrfFusion,
} from "./retrieval/keyword";
import { Fts5KeywordIndex } from "./adapters/keyword-fts5";
import { BlobScanVectorIndex } from "./adapters/vector-blob-scan";
import type { IndexCandidate, KeywordQuery } from "./ports/indexes";
import { planVectorScanScope } from "./retrieval/vector-scan-scope";

type ChunkRow = {
  id: string;
  documentId: string;
  documentName: string;
  pageNumber: number;
  position: number;
  content: string;
  source: "library" | "conversation_file";
  score?: number;
  revisionId?: string;
  processingBuildId?: string;
};

function candidateToChunk(c: IndexCandidate): ChunkRow {
  return {
    id: c.chunkId,
    documentId: c.documentId,
    documentName: c.documentName ?? c.documentId,
    pageNumber: c.pageNumber ?? 0,
    position: c.position ?? 0,
    content: c.content ?? "",
    source: c.source ?? "library",
    score: c.score,
    revisionId: c.revisionId,
    processingBuildId: c.processingBuildId,
  };
}

function legacyToRetrievalScope(scope: KnowledgeScope): RetrievalScope {
  if (scope.mode === "none") return { mode: "none" };
  if (scope.mode === "all") {
    return { mode: "sources", library: "all" };
  }
  if (scope.documentIds.length === 0) return { mode: "none" };
  return {
    mode: "sources",
    library: { documentIds: scope.documentIds },
  };
}

function isRetrievalScope(value: unknown): value is RetrievalScope {
  if (!value || typeof value !== "object") return false;
  const mode = (value as { mode?: unknown }).mode;
  return mode === "none" || mode === "sources";
}

function isKnowledgeScope(value: unknown): value is KnowledgeScope {
  if (!value || typeof value !== "object") return false;
  const mode = (value as { mode?: unknown }).mode;
  return mode === "none" || mode === "documents" || mode === "all";
}

export function normalizeRetrievalScope(
  input:
    | RetrievalScope
    | KnowledgeScope
    | {
        knowledgeDocumentId?: string;
        knowledgeScope?: KnowledgeScope | RetrievalScope;
        retrievalScope?: RetrievalScope;
      }
    | null
    | undefined,
): RetrievalScope {
  if (!input) return { mode: "none" };

  if ("retrievalScope" in input && input.retrievalScope) {
    return normalizeRetrievalScope(input.retrievalScope);
  }

  if (isRetrievalScope(input) && !("knowledgeScope" in input)) {
    if (input.mode === "none") return { mode: "none" };
    const library = input.library;
    const rawFiles = input.conversationFiles;
    const fileIds = Array.isArray(rawFiles?.fileIds)
      ? rawFiles.fileIds.filter(
          (id): id is string => typeof id === "string" && Boolean(id),
        )
      : [];
    const conversationId =
      typeof rawFiles?.conversationId === "string"
        ? rawFiles.conversationId.trim()
        : "";
    const files =
      conversationId && fileIds.length > 0
        ? { conversationId, fileIds }
        : undefined;
    if (!library && !files) return { mode: "none" };
    return {
      mode: "sources",
      ...(library ? { library } : {}),
      ...(files ? { conversationFiles: files } : {}),
    };
  }

  if ("knowledgeScope" in input && input.knowledgeScope) {
    return normalizeRetrievalScope(input.knowledgeScope);
  }

  if (isKnowledgeScope(input)) {
    return legacyToRetrievalScope(input);
  }

  if (
    "knowledgeDocumentId" in input &&
    typeof input.knowledgeDocumentId === "string" &&
    input.knowledgeDocumentId
  ) {
    return {
      mode: "sources",
      library: { documentIds: [input.knowledgeDocumentId] },
    };
  }

  return { mode: "none" };
}

function scopeHasSources(
  scope: Exclude<RetrievalScope, { mode: "none" }>,
): boolean {
  if (scope.library === "all") return true;
  if (
    scope.library &&
    typeof scope.library === "object" &&
    scope.library.documentIds.length > 0
  ) {
    return true;
  }
  return Boolean(
    scope.conversationFiles?.conversationId &&
      scope.conversationFiles.fileIds.length > 0,
  );
}

function scopeToKeywordOptions(
  scope: Exclude<RetrievalScope, { mode: "none" }>,
  topK: number,
) {
  const documentIds =
    scope.library && typeof scope.library === "object"
      ? scope.library.documentIds
      : undefined;
  return {
    topK,
    documentIds,
    libraryMode:
      scope.library === "all"
        ? ("all" as const)
        : documentIds
          ? ("documents" as const)
          : undefined,
    conversationFiles: scope.conversationFiles,
  };
}

export type HybridRetrieverOptions = {
  keywordIndex?: Fts5KeywordIndex;
  vectorIndex?: BlobScanVectorIndex;
};

export class HybridRetriever implements Retriever {
  private embedder: Embedder | null | undefined;
  private readonly keywordIndex: Fts5KeywordIndex;
  private readonly vectorIndex: BlobScanVectorIndex;

  constructor(
    embedder?: Embedder | null,
    options: HybridRetrieverOptions = {},
  ) {
    this.embedder = embedder;
    this.keywordIndex = options.keywordIndex ?? new Fts5KeywordIndex();
    this.vectorIndex = options.vectorIndex ?? new BlobScanVectorIndex();
  }

  async retrieve(
    query: string,
    scope: RetrievalScope,
    options: {
      topK?: number;
      preferKeyword?: boolean;
      keywordQuery?: KeywordQuery;
    } = {},
  ): Promise<RetrievalResult> {
    if (scope.mode === "none" || !scopeHasSources(scope)) {
      return { chunks: [], strategy: "keyword" };
    }

    const topK = options.topK ?? SEARCH_CONFIG.topK;
    const ftsQuery = options.keywordQuery ?? { text: query };
    const fts = await this.searchFts(ftsQuery, scope, Math.max(topK * 3, 24));

    if (!options.preferKeyword) {
      const embedder = await this.getEmbedder();
      if (embedder) {
        try {
          return await this.hybridSearch(query, scope, fts, embedder, topK);
        } catch (error) {
          console.warn("语义检索失败，降级到关键词匹配", error);
        }
      }
    }

    if (fts.available) {
      return {
        chunks: fts.chunks.slice(0, topK).map((chunk) => ({
          ...chunk,
          score: chunk.score ?? 0,
        })),
        strategy: "keyword",
      };
    }

    const chunks = await this.fetchChunks(scope);
    if (chunks.length === 0) {
      return { chunks: [], strategy: "keyword" };
    }
    return this.keywordSearch(query, chunks, topK);
  }

  private async getEmbedder(): Promise<Embedder | null> {
    if (this.embedder !== undefined) {
      return this.embedder;
    }
    this.embedder = await resolveEmbedder();
    return this.embedder;
  }

  private async searchFts(
    query: string | KeywordQuery,
    scope: Exclude<RetrievalScope, { mode: "none" }>,
    topK: number,
  ): Promise<{ available: boolean; chunks: ChunkRow[]; strategy?: string }> {
    // 无 library 仅有会话附件时，不要传 library:all
    const opts = scopeToKeywordOptions(scope, topK);
    if (!scope.library && scope.conversationFiles) {
      opts.libraryMode = undefined;
      opts.documentIds = undefined;
    }
    const detailed = await this.keywordIndex.searchDetailed(query, opts);
    return {
      available: detailed.available,
      chunks: detailed.candidates.map(candidateToChunk),
      strategy: detailed.strategy,
    };
  }

  private async fetchChunks(
    scope: Exclude<RetrievalScope, { mode: "none" }>,
  ): Promise<ChunkRow[]> {
    const response = await fetch(`${ORYNODE_DATA_URL}/retrieval/chunks/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        library:
          scope.library === "all"
            ? { mode: "all" }
            : scope.library
              ? { mode: "documents", documentIds: scope.library.documentIds }
              : undefined,
        conversationFiles: scope.conversationFiles
          ? {
              conversationId: scope.conversationFiles.conversationId,
              fileIds: scope.conversationFiles.fileIds,
            }
          : undefined,
        withVectors: false,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    if (!response.ok) {
      throw new Error("无法获取文档内容");
    }
    const result = await response.json();
    return (result.chunks ?? []).map(
      (chunk: {
        id: string;
        documentId: string;
        documentName?: string;
        pageNumber: number;
        position: number;
        content: string;
        source?: "library" | "conversation_file";
        revisionId?: string;
        processingBuildId?: string;
      }) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        documentName: chunk.documentName ?? chunk.documentId,
        pageNumber: chunk.pageNumber,
        position: chunk.position,
        content: chunk.content,
        source: chunk.source ?? "library",
        revisionId: chunk.revisionId,
        processingBuildId: chunk.processingBuildId,
      }),
    );
  }

  private keywordSearch(
    query: string,
    chunks: ChunkRow[],
    topK: number,
  ): RetrievalResult {
    const terms = extractSearchTerms(query);
    const scored = chunks.map((chunk) => ({
      ...chunk,
      score: keywordScore(chunk.content, terms),
    }));
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.pageNumber - b.pageNumber ||
        a.position - b.position,
    );
    const matched = scored.filter((chunk) => chunk.score > 0);
    return {
      chunks: matched.slice(0, topK),
      strategy: "keyword",
    };
  }

  private async hybridSearch(
    query: string,
    scope: Exclude<RetrievalScope, { mode: "none" }>,
    fts: { available: boolean; chunks: ChunkRow[]; strategy?: string },
    embedder: Embedder,
    topK: number,
  ): Promise<RetrievalResult> {
    let keywordRanked: string[] = [];
    let byId = new Map<string, ChunkRow>();
    const terms = extractSearchTerms(query);

    // 完整短语是最高等级的正文证据。已有 phrase 命中时不再混入向量近邻，
    // 否则会把一个精确结果扩散成固定数量的语义噪声。
    // strategy 仍报 keyword（本轮未做向量融合）；索引就绪与否由 capabilities 判定，勿在 Engine 误标。
    if (fts.strategy === "fts5_phrase" && fts.chunks.length > 0) {
      return {
        chunks: fts.chunks.slice(0, topK).map((chunk) => ({
          ...chunk,
          score: chunk.score ?? 0,
        })),
        strategy: "keyword",
      };
    }

    if (fts.available) {
      keywordRanked = fts.chunks.map((chunk) => chunk.id);
      byId = new Map(fts.chunks.map((chunk) => [chunk.id, chunk]));
    } else {
      const chunks = await this.fetchChunks(scope);
      keywordRanked = [...chunks]
        .map((chunk) => ({
          id: chunk.id,
          score: keywordScore(chunk.content, terms),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((item) => item.id);
      byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    }

    const queryVector = await embedder.embed(query);
    const keywordDocIds =
      keywordRanked.length > 0
        ? keywordRanked
            .map((id) => byId.get(id)?.documentId)
            .filter((id): id is string => Boolean(id))
        : [];
    const scanPlan = planVectorScanScope(scope, keywordDocIds);
    // 有关键词命中时只扫命中文档的向量；无命中则保持原 scope 做纯向量兜底
    const semanticResults = await this.vectorIndex.search(queryVector, {
      topK: topK * 2,
      scope: scanPlan.scope,
      documentIds: scanPlan.documentIds,
      maxScanChunks: SEARCH_CONFIG.maxVectorScanChunks,
    });
    for (const item of semanticResults) {
      if (!byId.has(item.chunkId)) {
        byId.set(item.chunkId, candidateToChunk(item));
      }
    }

    // 关键词 0 命中：只接受正文向量本身足够强的候选。
    // documentName/displayName 只是展示元数据，不参与召回，也不提供阈值豁免。
    if (keywordRanked.length === 0) {
      const strongVector = semanticResults.filter(
        (item) => item.score >= SEARCH_CONFIG.minVectorCosineSolo,
      );
      if (strongVector.length === 0) {
        return { chunks: [], strategy: "hybrid" };
      }

      // 这里只有一条排名列表，无需 RRF；保留真实余弦分数供诊断/UI 展示。
      const merged: RetrievalHit[] = strongVector
        .map((candidate) => {
          const chunk = byId.get(candidate.chunkId);
          if (!chunk) return null;
          return { ...chunk, score: candidate.score };
        })
        .filter((item): item is RetrievalHit => item !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      return { chunks: merged, strategy: "hybrid" };
    }

    const semanticRanked = semanticResults.map((item) => item.chunkId);

    if (semanticRanked.length === 0) {
      if (fts.available) {
        return {
          chunks: fts.chunks.slice(0, topK).map((chunk) => ({
            ...chunk,
            score: chunk.score ?? 0,
          })),
          strategy: "keyword",
        };
      }
      return this.keywordSearch(query, [...byId.values()], topK);
    }

    const lists = [keywordRanked, semanticRanked];
    const fused = rrfFusion(lists);

    const merged: RetrievalHit[] = [...fused.entries()]
      .map(([id, score]) => {
        const chunk = byId.get(id);
        if (!chunk) return null;
        return { ...chunk, score };
      })
      .filter((item): item is RetrievalHit => item !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return { chunks: merged, strategy: "hybrid" };
  }
}
