/**
 * VectorIndex adapter：BLOB 扫描（现有 SQLiteVectorStore）
 */

import type {
  EmbeddedChunk,
  IndexBuildRef,
  IndexCandidate,
  VectorIndex,
  VectorSearchOptions,
} from "../ports/indexes";
import type { RetrievalScope } from "../types";
import { SQLiteVectorStore } from "../vector-store";

export class BlobScanVectorIndex implements VectorIndex {
  readonly store: SQLiteVectorStore;

  constructor(store?: SQLiteVectorStore) {
    this.store = store ?? new SQLiteVectorStore();
  }

  async upsert(_build: IndexBuildRef, vectors: EmbeddedChunk[]): Promise<void> {
    await this.store.insert(
      vectors.map((item) => ({
        id: item.chunkId,
        documentId: item.documentId,
        vector: item.vector,
        namespace: "library" as const,
        metadata: {
          pageNumber: 0,
          position: 0,
          content: "",
        },
      })),
    );
  }

  async search(
    vector: Float32Array,
    options: VectorSearchOptions & {
      scope?: Exclude<RetrievalScope, { mode: "none" }>;
    },
  ): Promise<IndexCandidate[]> {
    const scope =
      options.scope ??
      (options.documentIds?.length
        ? {
            mode: "sources" as const,
            library: { documentIds: options.documentIds },
          }
        : { mode: "sources" as const, library: "all" as const });

    const hits = await this.store.search(vector, {
      topK: options.topK,
      scope,
    });
    return hits.map((hit) => ({
      chunkId: hit.chunk.id,
      documentId: hit.chunk.documentId,
      score: hit.score,
      content: hit.chunk.content,
      documentName: hit.chunk.documentName ?? hit.chunk.documentId,
      pageNumber: hit.chunk.pageNumber,
      position: hit.chunk.position,
      source: hit.chunk.source ?? "library",
      revisionId: (hit.chunk as { revisionId?: string }).revisionId,
      processingBuildId: (hit.chunk as { processingBuildId?: string })
        .processingBuildId,
    }));
  }
}
