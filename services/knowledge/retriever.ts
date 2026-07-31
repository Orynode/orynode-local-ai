/**
 * 混合检索器（唯一检索入口）
 *
 * - keyword：始终可用
 * - hybrid：Embedder 可用且库中有向量时，RRF 融合
 * - scope：none | documents[] | all
 */

import type {
  Embedder,
  KnowledgeScope,
  RetrievalHit,
  RetrievalResult,
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

export function normalizeKnowledgeScope(
  input:
    | KnowledgeScope
    | { knowledgeDocumentId?: string; knowledgeScope?: KnowledgeScope }
    | null
    | undefined,
): KnowledgeScope {
  if (!input) return { mode: "none" };
  if ("mode" in input) return input;
  if (input.knowledgeScope) return input.knowledgeScope;
  if (
    typeof input.knowledgeDocumentId === "string" &&
    input.knowledgeDocumentId
  ) {
    return { mode: "documents", documentIds: [input.knowledgeDocumentId] };
  }
  return { mode: "none" };
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
    scope: KnowledgeScope,
    options: { topK?: number } = {},
  ): Promise<RetrievalResult> {
    if (scope.mode === "none") {
      return { chunks: [], strategy: "keyword" };
    }
    if (scope.mode === "documents" && scope.documentIds.length === 0) {
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
    scope: Exclude<KnowledgeScope, { mode: "none" }>,
  ): Promise<
    Array<{
      id: string;
      documentId: string;
      documentName: string;
      pageNumber: number;
      position: number;
      content: string;
    }>
  > {
    const response = await fetch(`${ORYNODE_DATA_URL}/knowledge/chunks/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: scope.mode,
        documentIds: scope.mode === "documents" ? scope.documentIds : undefined,
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
      }) => ({
        id: chunk.id,
        documentId: chunk.documentId,
        documentName: chunk.documentName ?? chunk.documentId,
        pageNumber: chunk.pageNumber,
        position: chunk.position,
        content: chunk.content,
      }),
    );
  }

  private keywordSearch(
    query: string,
    chunks: Array<{
      id: string;
      documentId: string;
      documentName: string;
      pageNumber: number;
      position: number;
      content: string;
    }>,
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
    // 无词命中时不灌入「碰巧排前」的片段，避免伪引用
    return {
      chunks: matched.slice(0, topK),
      strategy: "keyword",
    };
  }

  private async hybridSearch(
    query: string,
    scope: Exclude<KnowledgeScope, { mode: "none" }>,
    chunks: Array<{
      id: string;
      documentId: string;
      documentName: string;
      pageNumber: number;
      position: number;
      content: string;
    }>,
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
