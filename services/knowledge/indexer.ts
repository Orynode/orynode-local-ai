/**
 * 文档向量索引与状态机
 *
 * status:
 *   awaiting_chunks — 原件已存，分块未提交（不可检索）
 *   ready           — 文本可 keyword 检索；尚无可用向量
 *   embedding       — 正在写向量（keyword 仍可用）
 *   indexed         — 文本 + 向量均可用（hybrid）
 *   error           — 向量失败；keyword 仍可用；可 reindex
 */

import { randomUUID } from "node:crypto";
import type { ChunkResult } from "./chunker";
import { resolveEmbedder, resetEmbedderCache, getEmbedderUnavailableReason } from "./embedder";
import { SQLiteVectorStore } from "./vector-store";
import {
  EMBEDDING_CONFIG,
  HTTP_TIMEOUT,
  ORYNODE_DATA_URL,
  SEARCH_CONFIG,
} from "../../config/defaults";
import type { KnowledgeDocument } from "../types";

export type IndexStatus = "indexed" | "ready" | "error" | "skipped";

async function setStatus(
  documentId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const response = await fetch(
    `${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(documentId)}/status`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, ...extra }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    },
  );
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `更新文档状态失败: ${status}`);
  }
}

async function fetchDocumentChunks(
  documentId: string,
): Promise<Array<ChunkResult & { id: string }>> {
  const response = await fetch(
    `${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(documentId)}/chunks`,
    {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    },
  );
  if (!response.ok) {
    throw new Error("无法读取文档分块");
  }
  const result = await response.json();
  return (result.chunks ?? []).map(
    (chunk: {
      id: string;
      pageNumber: number;
      position: number;
      content: string;
    }) => ({
      id: chunk.id,
      pageNumber: chunk.pageNumber,
      position: chunk.position,
      content: chunk.content,
    }),
  );
}

/**
 * 为已 commit 的文档构建向量索引。
 * Embedder 不可用时保持 ready（仅 keyword）。
 */
export async function indexDocumentEmbeddings(
  documentId: string,
  chunks?: Array<ChunkResult & { id: string }>,
): Promise<{ status: IndexStatus; reason?: string }> {
  if (!SEARCH_CONFIG.semanticSearchEnabled) {
    return { status: "skipped" };
  }

  const embedder = await resolveEmbedder();
  if (!embedder) {
    return {
      status: "ready",
      reason: getEmbedderUnavailableReason() || undefined,
    };
  }

  const targetChunks = chunks ?? (await fetchDocumentChunks(documentId));
  if (targetChunks.length === 0) {
    return { status: "ready", reason: "文档没有可用分块" };
  }

  try {
    // status=embedding 时 data-service 会先清空旧 BLOB
    await setStatus(documentId, "embedding");
    const vectors = await embedder.embedBatch(
      targetChunks.map((chunk) => chunk.content),
    );
    const store = new SQLiteVectorStore();
    await store.insert(
      targetChunks.map((chunk, index) => ({
        id: chunk.id,
        documentId,
        vector: vectors[index],
        metadata: {
          pageNumber: chunk.pageNumber,
          position: chunk.position,
          content: chunk.content,
        },
      })),
    );
    await setStatus(documentId, "indexed", {
      embeddingModel: embedder.modelName || EMBEDDING_CONFIG.modelName,
      embeddingDim: embedder.dimension || EMBEDDING_CONFIG.dimension,
      errorMessage: null,
    });
    return { status: "indexed" };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "向量索引失败";
    try {
      // status=error 时 data-service 会清空该文档 embedding BLOB
      await setStatus(documentId, "error", { errorMessage: message });
    } catch {
      // status update best-effort
    }
    return { status: "error", reason: message };
  }
}

/** 强制按库中 chunks 重建向量（开启语义后补齐旧文档） */
export async function reindexDocument(
  documentId: string,
): Promise<{ status: IndexStatus; reason?: string }> {
  resetEmbedderCache();
  if (!SEARCH_CONFIG.semanticSearchEnabled) {
    return {
      status: "skipped",
      reason: "未开启语义检索（在 .env.local 设置 ORYNODE_SEMANTIC_SEARCH=1）",
    };
  }
  const embedder = await resolveEmbedder();
  if (!embedder) {
    return {
      status: "skipped",
      reason:
        getEmbedderUnavailableReason() ||
        "向量模型不可用。请确认 data-service 已启动",
    };
  }
  const result = await indexDocumentEmbeddings(documentId);
  if (result.status === "ready") {
    return {
      status: "skipped",
      reason: result.reason || "文档没有可用分块，无法写入向量",
    };
  }
  if (result.status === "error") {
    return {
      status: "error",
      reason:
        result.reason ||
        "向量索引失败（旧向量已清空，仍可关键词检索）",
    };
  }
  return result;
}

export async function reindexAllDocuments(): Promise<{
  results: Array<{ id: string; status: IndexStatus; reason?: string }>;
}> {
  const listResponse = await fetch(`${ORYNODE_DATA_URL}/knowledge`, {
    cache: "no-store",
    signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
  });
  if (!listResponse.ok) {
    throw new Error("无法列出资料库文档");
  }
  const list = await listResponse.json();
  const documents: KnowledgeDocument[] = list.documents ?? [];
  const results: Array<{ id: string; status: IndexStatus; reason?: string }> =
    [];

  for (const document of documents) {
    if (
      document.status === "awaiting_chunks" ||
      !document.chunkCount ||
      document.chunkCount < 1
    ) {
      results.push({
        id: document.id,
        status: "skipped",
        reason: "尚无可用分块",
      });
      continue;
    }
    const result = await reindexDocument(document.id);
    results.push({ id: document.id, ...result });
  }

  return { results };
}

export function assignChunkIds(
  chunks: ChunkResult[],
): Array<ChunkResult & { id: string }> {
  return chunks.map((chunk) => ({
    ...chunk,
    id: randomUUID(),
  }));
}

export async function commitDocumentChunks(
  documentId: string,
  pageCount: number,
  chunks: Array<ChunkResult & { id: string }>,
): Promise<KnowledgeDocument> {
  const response = await fetch(
    `${ORYNODE_DATA_URL}/knowledge/${encodeURIComponent(documentId)}/chunks`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageCount, chunks }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledgeImport),
    },
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "写入文档分块失败");
  }
  return result.document as KnowledgeDocument;
}
