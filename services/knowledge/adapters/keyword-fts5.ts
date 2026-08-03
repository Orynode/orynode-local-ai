/**
 * KeywordIndex adapter：经 data-service FTS5 HTTP
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../config/defaults";
import type {
  IndexBuildRef,
  IndexCandidate,
  IndexChunk,
  KeywordIndex,
  KeywordQuery,
  KeywordSearchOptions,
} from "../ports/indexes";

function asKeywordQuery(query: string | KeywordQuery): KeywordQuery {
  if (typeof query === "string") {
    return { text: query };
  }
  return query;
}

export class Fts5KeywordIndex implements KeywordIndex {
  constructor(private readonly dataUrl = ORYNODE_DATA_URL) {}

  async upsert(_build: IndexBuildRef, _chunks: IndexChunk[]): Promise<void> {
    // FTS 由 commitDocumentChunks → data-service upsertFtsChunks 维护
  }

  async search(
    query: string | KeywordQuery,
    options: KeywordSearchOptions,
  ): Promise<IndexCandidate[]> {
    const detailed = await this.searchDetailed(query, options);
    return detailed.available ? detailed.candidates : [];
  }

  /**
   * 供 HybridRetriever 使用：带 available 标志与正文，避免 FTS 不可用时误判。
   */
  async searchDetailed(
    query: string | KeywordQuery,
    options: KeywordSearchOptions & {
      conversationFiles?: {
        conversationId: string;
        fileIds: string[];
      };
      libraryMode?: "all" | "documents";
    },
  ): Promise<{
    available: boolean;
    candidates: IndexCandidate[];
    strategy?: string;
    analyzerVersion?: string;
    activeKeywordBuild?: string;
    degradedReasons?: string[];
  }> {
    const documentIds = options.documentIds;
    let library:
      | { mode: "all" }
      | { mode: "documents"; documentIds: string[] }
      | undefined;
    if (options.libraryMode === "all") {
      library = { mode: "all" };
    } else if (documentIds && documentIds.length > 0) {
      library = { mode: "documents", documentIds };
    }

    const keywordQuery = asKeywordQuery(query);

    try {
      const response = await fetch(`${this.dataUrl}/retrieval/keyword/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: keywordQuery.text,
          terms: keywordQuery.terms,
          phrase: keywordQuery.phrase,
          exactTerms: keywordQuery.exactTerms,
          languagePrimary: keywordQuery.languagePrimary,
          topK: options.topK,
          preferLegacy: options.preferLegacy,
          library,
          conversationFiles: options.conversationFiles,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      });
      if (!response.ok) return { available: false, candidates: [] };
      const result = (await response.json()) as {
        strategy?: string;
        analyzerVersion?: string;
        activeKeywordBuild?: string;
        degradedReasons?: string[];
        chunks?: Array<{
          id: string;
          documentId: string;
          documentName?: string;
          pageNumber?: number;
          position?: number;
          content?: string;
          source?: "library" | "conversation_file";
          score?: number;
          revisionId?: string;
          processingBuildId?: string;
        }>;
      };
      if (result.strategy === "fts_unavailable") {
        return { available: false, candidates: [] };
      }
      return {
        available: true,
        strategy: result.strategy,
        analyzerVersion: result.analyzerVersion,
        activeKeywordBuild: result.activeKeywordBuild,
        degradedReasons: result.degradedReasons,
        candidates: (result.chunks ?? []).map((chunk) => ({
          chunkId: chunk.id,
          documentId: chunk.documentId,
          score: typeof chunk.score === "number" ? chunk.score : 0,
          content: chunk.content,
          documentName: chunk.documentName ?? chunk.documentId,
          pageNumber: chunk.pageNumber ?? 0,
          position: chunk.position ?? 0,
          source: chunk.source ?? "library",
          revisionId: chunk.revisionId,
          processingBuildId: chunk.processingBuildId,
        })),
      };
    } catch {
      return { available: false, candidates: [] };
    }
  }
}
