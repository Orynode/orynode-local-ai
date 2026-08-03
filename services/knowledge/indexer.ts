/**
 * 文档向量索引与状态机（资料库与会话附件共用）
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
import type { DocumentNamespace } from "./types";
import { resolveEmbedder, resetEmbedderCache, getEmbedderUnavailableReason } from "./embedder";
import { SQLiteVectorStore } from "./vector-store";
import {
  EMBEDDING_CONFIG,
  HTTP_TIMEOUT,
  ORYNODE_DATA_URL,
  SEARCH_CONFIG,
} from "../../config/defaults";
import type { ConversationFile, KnowledgeDocument } from "../types";

export type IndexStatus = "indexed" | "ready" | "error" | "skipped";

function basePath(namespace: DocumentNamespace): string {
  return namespace === "conversation"
    ? `${ORYNODE_DATA_URL}/conversation-files`
    : `${ORYNODE_DATA_URL}/knowledge`;
}

async function setStatus(
  documentId: string,
  status: string,
  extra: Record<string, unknown> = {},
  namespace: DocumentNamespace = "library",
): Promise<void> {
  const response = await fetch(
    `${basePath(namespace)}/${encodeURIComponent(documentId)}/status`,
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
  namespace: DocumentNamespace = "library",
): Promise<Array<ChunkResult & { id: string }>> {
  const response = await fetch(
    `${basePath(namespace)}/${encodeURIComponent(documentId)}/chunks`,
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
  namespace: DocumentNamespace = "library",
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

  const targetChunks =
    chunks ?? (await fetchDocumentChunks(documentId, namespace));
  if (targetChunks.length === 0) {
    return { status: "ready", reason: "文档没有可用分块" };
  }

  try {
    await setStatus(documentId, "embedding", {}, namespace);
    const vectors = await embedder.embedBatch(
      targetChunks.map((chunk) => chunk.content),
    );
    const store = new SQLiteVectorStore();
    await store.insert(
      targetChunks.map((chunk, index) => ({
        id: chunk.id,
        documentId,
        vector: vectors[index],
        namespace,
        metadata: {
          pageNumber: chunk.pageNumber,
          position: chunk.position,
          content: chunk.content,
        },
      })),
    );
    await setStatus(
      documentId,
      "indexed",
      {
        embeddingModel: embedder.modelName || EMBEDDING_CONFIG.modelName,
        embeddingDim: embedder.dimension || EMBEDDING_CONFIG.dimension,
        errorMessage: null,
      },
      namespace,
    );
    return { status: "indexed" };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "向量索引失败";
    try {
      await setStatus(
        documentId,
        "error",
        { errorMessage: message },
        namespace,
      );
    } catch {
      // status update best-effort
    }
    return { status: "error", reason: message };
  }
}

/**
 * 强制按库中 chunks 重建向量。
 * Phase 2：优先入队持久化 Job（可恢复）；Job API 不可用时回退同步路径。
 */
export async function reindexDocument(
  documentId: string,
  namespace: DocumentNamespace = "library",
): Promise<{ status: IndexStatus; reason?: string; jobId?: string }> {
  resetEmbedderCache();
  if (!SEARCH_CONFIG.semanticSearchEnabled) {
    return {
      status: "skipped",
      reason:
        "主机未加载向量模型。Balanced/Quality 档需在 .env.local 设置 ORYNODE_SEMANTIC_SEARCH=1",
    };
  }

  try {
    const enqueue = await fetch(`${ORYNODE_DATA_URL}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "embed_document",
        idempotencyKey: `reindex:${namespace}:${documentId}:${Date.now()}`,
        payload: { namespace, documentId },
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    if (enqueue.ok) {
      const body = await enqueue.json();
      await setStatus(documentId, "embedding", {}, namespace);
      return {
        status: "skipped",
        reason: "已入队后台向量重建",
        jobId: body.job?.id,
      };
    }
  } catch {
    // fall through to sync path
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
  const result = await indexDocumentEmbeddings(documentId, undefined, namespace);
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
    const result = await reindexDocument(document.id, "library");
    results.push({ id: document.id, ...result });
  }

  return { results };
}

export type VectorBackfillResult = {
  totalDocuments: number;
  indexedDocuments: number;
  pendingDocuments: number;
  enqueued: number;
  skipped: number;
};

let lastBackfillAt = 0;
let lastBackfillResult: VectorBackfillResult | null = null;

/**
 * 为尚未完成向量索引的资料库文档入队 embed_document（幂等）。
 * 关键词索引不受影响；Chat 活跃时由 resource coordinator 延迟执行。
 */
export async function enqueuePendingVectorBackfill(): Promise<VectorBackfillResult> {
  const empty: VectorBackfillResult = {
    totalDocuments: 0,
    indexedDocuments: 0,
    pendingDocuments: 0,
    enqueued: 0,
    skipped: 0,
  };

  if (!SEARCH_CONFIG.semanticSearchEnabled) {
    return empty;
  }

  const listResponse = await fetch(`${ORYNODE_DATA_URL}/knowledge`, {
    cache: "no-store",
    signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
  });
  if (!listResponse.ok) {
    throw new Error("无法列出资料库文档");
  }
  const list = await listResponse.json();
  const documents: KnowledgeDocument[] = list.documents ?? [];
  const searchable = documents.filter(
    (doc) =>
      (doc.chunkCount ?? 0) > 0 &&
      doc.status != null &&
      ["ready", "embedding", "indexed", "error"].includes(doc.status),
  );
  const indexed = searchable.filter((doc) => doc.status === "indexed");
  const pending = searchable.filter((doc) => doc.status !== "indexed");

  let enqueued = 0;
  let skipped = 0;

  for (const document of pending) {
    try {
      const enqueue = await fetch(`${ORYNODE_DATA_URL}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "embed_document",
          idempotencyKey: `backfill:library:${document.id}`,
          payload: { namespace: "library", documentId: document.id },
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      });
      if (!enqueue.ok) {
        skipped += 1;
        continue;
      }
      const body = (await enqueue.json()) as {
        job?: { status?: string; id?: string };
      };
      const status = body.job?.status;
      if (status === "queued" || status === "retry_wait" || status === "running") {
        enqueued += 1;
        if (document.status === "ready" || document.status === "error") {
          await setStatus(document.id, "embedding", {}, "library").catch(
            () => undefined,
          );
        }
      } else if (status === "failed" || status === "cancelled") {
        // 终端失败：用带时间戳的 key 再入队一次
        const retry = await fetch(`${ORYNODE_DATA_URL}/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "embed_document",
            idempotencyKey: `backfill:library:${document.id}:${Date.now()}`,
            payload: { namespace: "library", documentId: document.id },
          }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
        });
        if (retry.ok) {
          enqueued += 1;
          await setStatus(document.id, "embedding", {}, "library").catch(
            () => undefined,
          );
        } else {
          skipped += 1;
        }
      } else {
        // succeeded 但文档仍非 indexed：强制再入队
        if (document.status !== "indexed") {
          const retry = await fetch(`${ORYNODE_DATA_URL}/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "embed_document",
              idempotencyKey: `backfill:retry:library:${document.id}:${Date.now()}`,
              payload: { namespace: "library", documentId: document.id },
            }),
            signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
          });
          if (retry.ok) {
            enqueued += 1;
          } else {
            skipped += 1;
          }
        } else {
          skipped += 1;
        }
      }
    } catch {
      skipped += 1;
    }
  }

  return {
    totalDocuments: searchable.length,
    indexedDocuments: indexed.length,
    pendingDocuments: pending.length,
    enqueued,
    skipped,
  };
}

/**
 * 节流版补建：能力探测 / UI 刷新可反复调用，不会打爆 Job 队列。
 */
export async function ensurePendingVectorBackfill(
  minIntervalMs = 30_000,
): Promise<VectorBackfillResult | null> {
  if (!SEARCH_CONFIG.semanticSearchEnabled) return null;
  const now = Date.now();
  if (lastBackfillResult && now - lastBackfillAt < minIntervalMs) {
    return lastBackfillResult;
  }
  try {
    lastBackfillResult = await enqueuePendingVectorBackfill();
    lastBackfillAt = now;
    return lastBackfillResult;
  } catch {
    return lastBackfillResult;
  }
}

/** 测试用：重置补建节流 */
export function resetVectorBackfillThrottleForTests(): void {
  lastBackfillAt = 0;
  lastBackfillResult = null;
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
  namespace: DocumentNamespace = "library",
): Promise<KnowledgeDocument | ConversationFile> {
  const response = await fetch(
    `${basePath(namespace)}/${encodeURIComponent(documentId)}/chunks`,
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
  if (namespace === "conversation") {
    return result.file as ConversationFile;
  }
  return result.document as KnowledgeDocument;
}
