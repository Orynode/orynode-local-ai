/**
 * Next Wiki 读 API 的 Scope：资料库默认 library:all；
 * 会话页必须带 conversationId + fileId，并校验附件归属。
 */

import { HTTP_TIMEOUT, ORYNODE_DATA_URL } from "../../../config/defaults";
import { knowledgeOpenPage } from "../../agent/knowledge-tools";
import { KnowledgeError } from "../core/errors";
import type { RetrievalScope } from "../types";

export type WikiHttpContext = {
  scope: RetrievalScope;
  conversationId?: string | null;
};

export function wikiBrowseContextFromRequest(request: Request): WikiHttpContext {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId")?.trim() || null;
  const fileIds = url.searchParams
    .getAll("fileId")
    .map((id) => id.trim())
    .filter(Boolean);
  if (conversationId && fileIds.length > 0) {
    return {
      scope: {
        mode: "sources",
        library: "all",
        conversationFiles: { conversationId, fileIds },
      },
      conversationId,
    };
  }
  return {
    scope: { mode: "sources", library: "all" },
    conversationId,
  };
}

/** 写路径 Scope：会话页必须带 conversationId + fileId，不接受客户端 JSON。 */
export function wikiWriteContext(input: {
  namespace: "library" | "conversation";
  conversationId?: string | null;
  fileIds?: string[];
}): WikiHttpContext {
  const conversationId = String(input.conversationId || "").trim() || null;
  const fileIds = (input.fileIds ?? [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  if (input.namespace === "conversation") {
    if (!conversationId || fileIds.length === 0) {
      return { scope: { mode: "none" }, conversationId };
    }
    return {
      scope: {
        mode: "sources",
        library: "all",
        conversationFiles: { conversationId, fileIds },
      },
      conversationId,
    };
  }
  return {
    scope: { mode: "sources", library: "all" },
    conversationId,
  };
}

export async function requireReadableWikiPage(
  pageId: string,
  ctx: WikiHttpContext,
) {
  const gated = await ensureWikiConversationAccess(ctx);
  return knowledgeOpenPage(pageId, {
    scope: gated.scope,
    conversationId: gated.conversationId,
  });
}

export async function ensureWikiConversationAccess(
  ctx: WikiHttpContext,
): Promise<WikiHttpContext> {
  if (ctx.scope.mode !== "sources" || !ctx.scope.conversationFiles) return ctx;
  const files = ctx.scope.conversationFiles;
  for (const fileId of files.fileIds) {
    if (!(await conversationFileBelongsTo(files.conversationId, fileId))) {
      return { scope: { mode: "none" }, conversationId: ctx.conversationId };
    }
  }
  return ctx;
}

export function wikiToolErrorResponse(error: unknown): Response | null {
  if (!(error instanceof KnowledgeError)) return null;
  if (
    error.code === "page_not_found" ||
    error.code === "page_not_in_scope" ||
    error.code === "invalid_scope"
  ) {
    return Response.json(
      { error: "百科页不存在", code: "not_found" },
      { status: 404 },
    );
  }
  return null;
}

export async function conversationFileBelongsTo(
  conversationId: string,
  fileId: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${ORYNODE_DATA_URL}/conversation-files/${encodeURIComponent(fileId)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    if (!response.ok) return false;
    const body = (await response.json()) as {
      file?: { conversationId?: string };
    };
    const metaId = String(body.file?.conversationId || "").trim();
    return Boolean(metaId) && metaId === conversationId.trim();
  } catch {
    return false;
  }
}
