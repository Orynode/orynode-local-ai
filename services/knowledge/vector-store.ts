/**
 * 向量存储客户端
 *
 * 经 data-service HTTP 读写 SQLite BLOB；本类不直接打开数据库。
 * - insert：写入 chunk embedding
 * - search：按 scope 拉取带向量的 chunks，JS 余弦 Top-K
 *
 * 删除文档时由 data-service CASCADE 处理，不在此封装。
 */

import type {
  KnowledgeScope,
  SearchResult,
  VectorDocument,
  VectorStore,
} from "./types";
import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../config/defaults";

function float32ToNumberArray(vector: Float32Array): number[] {
  return Array.from(vector);
}

export class SQLiteVectorStore implements VectorStore {
  private readonly dataUrl: string;

  constructor(dataUrl = ORYNODE_DATA_URL) {
    this.dataUrl = dataUrl;
  }

  async insert(vectors: VectorDocument[]): Promise<void> {
    if (vectors.length === 0) return;

    const response = await fetch(`${this.dataUrl}/knowledge/vectors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vectors: vectors.map((item) => ({
          id: item.id,
          documentId: item.documentId,
          vector: float32ToNumberArray(item.vector),
        })),
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
    });

    if (!response.ok) {
      throw new Error("向量存储失败");
    }
  }

  async search(
    queryVector: Float32Array,
    options: {
      topK?: number;
      scope?: Exclude<KnowledgeScope, { mode: "none" }>;
    } = {},
  ): Promise<SearchResult[]> {
    const topK = options.topK ?? 8;
    const scope = options.scope ?? { mode: "all" as const };

    const response = await fetch(`${this.dataUrl}/knowledge/chunks/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: scope.mode,
        documentIds: scope.mode === "documents" ? scope.documentIds : undefined,
        withVectors: true,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });

    if (!response.ok) {
      throw new Error("无法获取文档向量数据");
    }

    const result = await response.json();
    const chunks: Array<{
      id: string;
      documentId: string;
      documentName?: string;
      pageNumber: number;
      position: number;
      content: string;
      embedding: number[] | null;
    }> = result.chunks ?? [];

    const scored = chunks
      .filter((chunk) => chunk.embedding && chunk.embedding.length > 0)
      .map((chunk) => ({
        chunk: {
          id: chunk.id,
          documentId: chunk.documentId,
          documentName: chunk.documentName,
          pageNumber: chunk.pageNumber,
          position: chunk.position,
          content: chunk.content,
        },
        score: cosineSimilarity(
          queryVector,
          new Float32Array(chunk.embedding!),
        ),
      }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度不匹配: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
