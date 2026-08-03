/**
 * 按 chunk id 打开片段（Agent open / Citation resolve）
 *
 * 必须携带 Scope；chunk id 不能单独授权（KE-P0-01）。
 */

import { ORYNODE_DATA_URL, HTTP_TIMEOUT } from "../../../config/defaults";
import { KnowledgeError } from "../core/errors";
import type { Citation, ResolvedCitation } from "../core/types";
import {
  LEGACY_PROCESSING_BUILD_ID,
  LEGACY_REVISION_ID,
} from "../core/types";
import type { RetrievalHit, RetrievalScope } from "../types";
import { enrichCitationsWithSourceLocators } from "../context/enrich-citations";
import {
  defaultScopePolicy,
  type ChunkAccessMeta,
  type KnowledgeAccessContext,
  type ScopePolicy,
} from "./scope-policy";

type RawChunk = RetrievalHit & {
  conversationId?: string | null;
};

/**
 * 内部读取（无授权）。仅供 ScopePolicy 校验前取 meta；
 * 对外请用 openChunkInScope / resolveCitationInScope。
 */
export async function fetchChunkById(
  chunkId: string,
): Promise<RawChunk | null> {
  const id = chunkId.trim();
  if (!id) return null;
  try {
    const response = await fetch(
      `${ORYNODE_DATA_URL}/retrieval/chunks/${encodeURIComponent(id)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      chunk?: (RetrievalHit & { conversationId?: string }) | null;
    };
    if (!body.chunk?.id) return null;
    return {
      id: body.chunk.id,
      documentId: body.chunk.documentId,
      documentName: body.chunk.documentName,
      pageNumber: body.chunk.pageNumber,
      position: body.chunk.position,
      content: body.chunk.content,
      score: typeof body.chunk.score === "number" ? body.chunk.score : 0,
      source: body.chunk.source === "conversation_file"
        ? "conversation_file"
        : "library",
      conversationId:
        typeof body.chunk.conversationId === "string"
          ? body.chunk.conversationId
          : null,
      revisionId:
        typeof (body.chunk as { revisionId?: string }).revisionId === "string"
          ? (body.chunk as { revisionId: string }).revisionId
          : undefined,
      processingBuildId:
        typeof (body.chunk as { processingBuildId?: string }).processingBuildId ===
        "string"
          ? (body.chunk as { processingBuildId: string }).processingBuildId
          : undefined,
    };
  } catch {
    return null;
  }
}

function toAccessMeta(chunk: RawChunk): ChunkAccessMeta {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    source: chunk.source,
    conversationId: chunk.conversationId,
  };
}

export type OpenChunkRequest = {
  chunkId: string;
  scope: RetrievalScope | unknown;
};

/**
 * 在 Scope 内打开 chunk。无权或不存在均抛 chunk_not_found（HTTP 层统一 404），
 * 但若明确存在却越权，抛 chunk_not_in_scope 供 Agent 稳定错误码。
 */
export async function openChunkInScope(
  request: OpenChunkRequest,
  access: KnowledgeAccessContext,
  policy: ScopePolicy = defaultScopePolicy,
): Promise<RetrievalHit> {
  const resolved = await policy.resolve(request.scope, access);
  const chunk = await fetchChunkById(request.chunkId);
  if (!chunk) {
    throw new KnowledgeError("chunk_not_found", "chunk 不可用");
  }
  const allowed = await policy.canReadChunk(toAccessMeta(chunk), resolved);
  if (!allowed) {
    throw new KnowledgeError(
      "chunk_not_in_scope",
      "CHUNK_NOT_IN_SCOPE",
    );
  }
  const { conversationId: _cid, ...hit } = chunk;
  return hit;
}

export async function citationFromChunk(
  chunk: RetrievalHit,
  citationId = "S1",
): Promise<Citation> {
  const base: Citation = {
    id: citationId,
    chunkId: chunk.id,
    documentId: chunk.documentId,
    revisionId: chunk.revisionId ?? LEGACY_REVISION_ID,
    processingBuildId: chunk.processingBuildId ?? LEGACY_PROCESSING_BUILD_ID,
    title: chunk.documentName,
    sourceType: chunk.source,
    locator: { kind: "page", page: chunk.pageNumber },
    excerpt:
      chunk.content.length > 240
        ? `${chunk.content.slice(0, 240)}…`
        : chunk.content,
  };
  const [enriched] = await enrichCitationsWithSourceLocators([base]);
  return enriched;
}

export async function resolveCitationInScope(
  request: OpenChunkRequest,
  access: KnowledgeAccessContext,
  policy: ScopePolicy = defaultScopePolicy,
): Promise<ResolvedCitation> {
  try {
    const chunk = await openChunkInScope(request, access, policy);
    return {
      citation: await citationFromChunk(chunk, chunk.id),
      available: true,
    };
  } catch (error) {
    if (
      error instanceof KnowledgeError &&
      (error.code === "chunk_not_found" || error.code === "chunk_not_in_scope")
    ) {
      return {
        citation: {
          id: request.chunkId,
          chunkId: request.chunkId,
          documentId: "",
          revisionId: LEGACY_REVISION_ID,
          processingBuildId: LEGACY_PROCESSING_BUILD_ID,
          title: "",
          sourceType: "unknown",
          locator: { kind: "text", startOffset: 0, endOffset: 0 },
          excerpt: "",
        },
        available: false,
        reason: "unavailable",
      };
    }
    throw error;
  }
}
