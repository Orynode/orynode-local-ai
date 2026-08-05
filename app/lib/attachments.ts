/**
 * 对话附件 ↔ 检索范围
 *
 * - library / library_all：持久资料库
 * - conversation_file：本会话附件
 * 草稿选中只作用于本条消息；会话文件本身绑 conversationId 可再选。
 *
 * library_all 表示「整库检索范围」。无法检索的文档（processing_error 等）
 * 仍会被 FTS / chunk 查询白名单过滤，不会当成证据返回。
 * 资料库页的「全部可检索资料」则显式枚举当前可用 id，语义更窄。
 */

import type {
  ConversationFile,
  KnowledgeDocument,
  MessageAttachment,
} from "../../services/types";
import type { RetrievalScope } from "../../services/knowledge/types";

/** 将可能含旧 kind 的附件规范为新模型 */
export function normalizeAttachment(
  item: unknown,
): MessageAttachment | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!id || !name) return null;

  if (raw.kind === "conversation_file") {
    return { kind: "conversation_file", id, name };
  }
  if (raw.kind === "library_all" || raw.kind === "all") {
    return { kind: "library_all", id: "all", name: name || "全部资料" };
  }
  if (raw.kind === "library" || raw.kind === "document") {
    return { kind: "library", id, name };
  }
  return null;
}

export function normalizeAttachments(
  value: unknown,
): MessageAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => normalizeAttachment(item))
    .filter((item): item is MessageAttachment => item !== null);
  return items.length > 0 ? items : undefined;
}

export function scopeFromAttachments(
  attachments: MessageAttachment[] | undefined,
  conversationId?: string | null,
): RetrievalScope {
  if (!attachments || attachments.length === 0) {
    return { mode: "none" };
  }

  const useAllLibrary = attachments.some((item) => item.kind === "library_all");
  const libraryIds = attachments
    .filter((item) => item.kind === "library")
    .map((item) => item.id);
  const fileIds = attachments
    .filter((item) => item.kind === "conversation_file")
    .map((item) => item.id);

  const library = useAllLibrary
    ? ("all" as const)
    : libraryIds.length > 0
      ? { documentIds: libraryIds }
      : undefined;
  // 无 conversationId 时不传会话附件 scope，避免跨会话按 fileId 检索
  const conversationFiles =
    fileIds.length > 0 && conversationId
      ? { conversationId, fileIds }
      : undefined;

  if (!library && !conversationFiles) {
    return { mode: "none" };
  }

  return {
    mode: "sources",
    ...(library ? { library } : {}),
    ...(conversationFiles ? { conversationFiles } : {}),
  };
}

export function attachmentFromDocument(
  document: KnowledgeDocument,
): MessageAttachment {
  return {
    id: document.id,
    name: document.name,
    kind: "library",
  };
}

export function attachmentFromConversationFile(
  file: ConversationFile,
): MessageAttachment {
  return {
    id: file.id,
    name: file.name,
    kind: "conversation_file",
  };
}

export function allDocumentsAttachment(): MessageAttachment {
  return {
    id: "all",
    name: "全部资料",
    kind: "library_all",
  };
}

/** 草稿里切换单篇资料库文档：若当前是「全部」，先拆成单篇再切换 */
export function toggleDraftDocument(
  draft: MessageAttachment[],
  document: KnowledgeDocument,
): MessageAttachment[] {
  const withoutAll = draft.filter((item) => item.kind !== "library_all");
  const exists = withoutAll.some(
    (item) => item.kind === "library" && item.id === document.id,
  );
  if (exists) {
    return withoutAll.filter(
      (item) => !(item.kind === "library" && item.id === document.id),
    );
  }
  return [...withoutAll, attachmentFromDocument(document)];
}

/** 草稿里切换本会话附件 */
export function toggleDraftConversationFile(
  draft: MessageAttachment[],
  file: ConversationFile,
): MessageAttachment[] {
  const exists = draft.some(
    (item) => item.kind === "conversation_file" && item.id === file.id,
  );
  if (exists) {
    return draft.filter(
      (item) => !(item.kind === "conversation_file" && item.id === file.id),
    );
  }
  return [...draft, attachmentFromConversationFile(file)];
}

export function removeDraftAttachment(
  draft: MessageAttachment[],
  id: string,
): MessageAttachment[] {
  return draft.filter((item) => item.id !== id);
}

export function isLibraryAll(item: MessageAttachment): boolean {
  return item.kind === "library_all";
}
