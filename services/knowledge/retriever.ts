/**
 * 混合检索器（唯一检索入口）
 *
 * - keyword：始终可用
 * - hybrid：Embedder 可用且库中有向量时，RRF 融合
 * - scope：RetrievalScope（资料库 + 会话附件）
 */

import type {
  Embedder,
  KnowledgeScope,
  RetrievalHit,
  RetrievalResult,
  RetrievalScope,
  Retriever,
  VectorStore,
} from "./types";
import { resolveEmbedder } from "./embedder";
import { SQLiteVectorStore } from "./vector-store";
import {
  SEARCH_CONFIG,
  ORYNODE_DATA_URL,
  HTTP_TIMEOUT,
} from "../../config/defaults";

type ChunkRow = {
  id: string;
  documentId: string;
  documentName: string;
  pageNumber: number;
  position: number;
  content: string;
  source: "library" | "conversation_file";
};

function extractSearchTerms(query: string): string[] {
  const normalized = query.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const terms = new Set<string>();

  for (const match of normalized.matchAll(/[a-z0-9_]{2,}/g)) {
    terms.add(match[0]);
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = match[0];
    for (let i = 0; i < run.length - 1; i += 1) {
      terms.add(run.slice(i, i + 2));
    }
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}]{3,}/gu)) {
    terms.add(match[0]);
  }

  return [...terms]
    .filter((term) => term.length >= 2)
    .slice(0, SEARCH_CONFIG.maxSearchTerms);
}

function keywordScore(chunkContent: string, terms: string[]): number {
  const content = chunkContent.toLocaleLowerCase();
  let score = 0;
  for (const term of terms) {
    let pos = content.indexOf(term);
    while (pos !== -1) {
      score += term.length;
      pos = content.indexOf(term, pos + term.length);
    }
  }
  return score;
}

/** RRF：按排名 rank（从 0 起）加权，而不是 chunk 下标 */
function rrfFusion(
  rankedIdLists: string[][],
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranked of rankedIdLists) {
    ranked.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
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

export class HybridRetriever implements Retriever {
  private embedder: Embedder | null | undefined;
  private readonly vectorStore: VectorStore;

  constructor(
    embedder?: Embedder | null,
    vectorStore?: VectorStore,
  ) {
    this.embedder = embedder;
    this.vectorStore = vectorStore ?? new SQLiteVectorStore();
  }

  async retrieve(
    query: string,
    scope: RetrievalScope,
    options: { topK?: number } = {},
  ): Promise<RetrievalResult> {
    if (scope.mode === "none" || !scopeHasSources(scope)) {
      return { chunks: [], strategy: "keyword" };
    }

    const topK = options.topK ?? SEARCH_CONFIG.topK;
    const chunks = await this.fetchChunks(scope);
    if (chunks.length === 0) {
      return { chunks: [], strategy: "keyword" };
    }

    const embedder = await this.getEmbedder();
    if (embedder) {
      try {
        return await this.hybridSearch(query, scope, chunks, embedder, topK);
      } catch (error) {
        console.warn("语义检索失败，降级到关键词匹配", error);
      }
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
      }) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        documentName: chunk.documentName ?? chunk.documentId,
        pageNumber: chunk.pageNumber,
        position: chunk.position,
        content: chunk.content,
        source: chunk.source ?? "library",
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
    chunks: ChunkRow[],
    embedder: Embedder,
    topK: number,
  ): Promise<RetrievalResult> {
    const terms = extractSearchTerms(query);
    const keywordRanked = [...chunks]
      .map((chunk) => ({
        id: chunk.id,
        score: keywordScore(chunk.content, terms),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.id);

    const queryVector = await embedder.embed(query);
    const semanticResults = await this.vectorStore.search(queryVector, {
      scope,
      topK: topK * 2,
    });
    const semanticRanked = semanticResults.map((item) => item.chunk.id);

    if (semanticRanked.length === 0) {
      return this.keywordSearch(query, chunks, topK);
    }

    const lists =
      keywordRanked.length > 0
        ? [keywordRanked, semanticRanked]
        : [semanticRanked];
    const fused = rrfFusion(lists);
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));

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
