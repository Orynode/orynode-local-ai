/**
 * Chat 检索范围解析：规范化 + 会话附件归属收紧
 */

import { normalizeRetrievalScope } from "../retriever";
import type { RetrievalScope } from "../types";

export type ChatScopeInput = {
  retrievalScope?: unknown;
  knowledgeScope?: unknown;
  knowledgeDocumentId?: string;
  conversationId?: string | null;
};

/**
 * 从 Chat 请求体解析 RetrievalScope。
 * 会话附件必须绑定 conversationId；禁止仅凭客户端 fileId 跨会话捞片段。
 */
export function resolveChatRetrievalScope(
  input: ChatScopeInput,
): RetrievalScope {
  const conversationId =
    typeof input.conversationId === "string" && input.conversationId.trim()
      ? input.conversationId.trim()
      : null;

  let scope = normalizeRetrievalScope(
    input as Parameters<typeof normalizeRetrievalScope>[0],
  );

  const incomingFileIds = Array.isArray(
    (input.retrievalScope as { conversationFiles?: { fileIds?: unknown } })
      ?.conversationFiles?.fileIds,
  )
    ? (
        input.retrievalScope as {
          conversationFiles: { fileIds: unknown[] };
        }
      ).conversationFiles.fileIds.filter(
        (id: unknown): id is string => typeof id === "string" && Boolean(id),
      )
    : scope.mode === "sources" && scope.conversationFiles
      ? scope.conversationFiles.fileIds
      : [];

  if (conversationId && incomingFileIds.length > 0) {
    const library = scope.mode === "sources" ? scope.library : undefined;
    scope = {
      mode: "sources",
      ...(library ? { library } : {}),
      conversationFiles: { conversationId, fileIds: incomingFileIds },
    };
  } else if (scope.mode === "sources" && scope.conversationFiles) {
    scope = scope.library
      ? { mode: "sources", library: scope.library }
      : { mode: "none" };
  }

  return scope;
}
