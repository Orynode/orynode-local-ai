/**
 * 对话附件 ↔ 检索范围
 *
 * 资料库是工作区记忆（NotebookLM / Claude Projects）：
 * 有可检索文档时默认 library:all，不写成消息附件。
 * 选单篇是收窄；本轮附件只保留会话文件。
 *
 * library_all 仍可从旧消息里读出，新发送不再写入。
 */

import type {
  ConversationFile,
  KnowledgeDocument,
  MessageAttachment,
} from "../../services/types";
import type { RetrievalScope } from "../../services/knowledge/types";
import { isUsableLibraryDocument } from "../../services/knowledge/status";

/** 工作区资料库怎么进这一轮检索：默认整库，可收窄或关掉 */
export type LibraryGrounding =
  | { mode: "workspace" }
  | { mode: "off" }
  | { mode: "pins"; documentIds: string[] };

export const WORKSPACE_GROUNDING: LibraryGrounding = { mode: "workspace" };

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

type ConversationFileScope = {
  conversationId: string;
  fileIds: string[];
};

function conversationFileScope(
  attachments: MessageAttachment[] | undefined,
  conversationId?: string | null,
): ConversationFileScope | undefined {
  if (!attachments || !conversationId) return undefined;
  const fileIds = attachments
    .filter((item) => item.kind === "conversation_file")
    .map((item) => item.id);
  if (fileIds.length === 0) return undefined;
  return { conversationId, fileIds };
}

function withSources(
  library: { documentIds: string[] } | "all" | undefined,
  conversationFiles: ConversationFileScope | undefined,
): RetrievalScope {
  if (!library && !conversationFiles) return { mode: "none" };
  return {
    mode: "sources",
    ...(library ? { library } : {}),
    ...(conversationFiles ? { conversationFiles } : {}),
  };
}

/**
 * 当前产品入口：工作区 grounding + 本轮会话附件。
 * 空附件不再等于「不查资料库」。
 */
export function resolveRetrievalScope(input: {
  grounding: LibraryGrounding;
  attachments?: MessageAttachment[];
  conversationId?: string | null;
  hasSearchableLibrary: boolean;
}): RetrievalScope {
  const conversationFiles = conversationFileScope(
    input.attachments,
    input.conversationId,
  );
  if (input.grounding.mode === "off") {
    return withSources(undefined, conversationFiles);
  }
  if (input.grounding.mode === "pins") {
    const documentIds = [
      ...new Set(input.grounding.documentIds.map((id) => id.trim()).filter(Boolean)),
    ];
    return withSources(
      documentIds.length > 0 ? { documentIds } : undefined,
      conversationFiles,
    );
  }
  return withSources(
    input.hasSearchableLibrary ? "all" : undefined,
    conversationFiles,
  );
}

/**
 * 兼容旧路径：只从附件推导 scope。
 * 空附件 = none（历史气泡 / 旧调用）。新 Chat 请用 resolveRetrievalScope。
 */
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
  const conversationFiles = conversationFileScope(attachments, conversationId);

  const library = useAllLibrary
    ? ("all" as const)
    : libraryIds.length > 0
      ? { documentIds: libraryIds }
      : undefined;

  return withSources(library, conversationFiles);
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

export function conversationFileAttachments(
  attachments: MessageAttachment[],
): MessageAttachment[] {
  return attachments.filter((item) => item.kind === "conversation_file");
}

export function togglePinnedDocument(
  grounding: LibraryGrounding,
  documentId: string,
): LibraryGrounding {
  const current = grounding.mode === "pins" ? grounding.documentIds : [];
  const exists = current.includes(documentId);
  const next = exists
    ? current.filter((id) => id !== documentId)
    : [...current, documentId];
  if (next.length === 0) return WORKSPACE_GROUNDING;
  return { mode: "pins", documentIds: next };
}

/** 资料库多选「去对话」：全选等于工作区，子集才收窄 */
export function groundingFromLibrarySelection(
  selectedIds: string[],
  usableIds: string[],
): LibraryGrounding {
  if (selectedIds.length === 0) return WORKSPACE_GROUNDING;
  if (
    usableIds.length > 0 &&
    usableIds.every((id) => selectedIds.includes(id))
  ) {
    return WORKSPACE_GROUNDING;
  }
  return { mode: "pins", documentIds: [...selectedIds] };
}

export function dropPinnedDocument(
  grounding: LibraryGrounding,
  documentId: string,
): LibraryGrounding {
  if (grounding.mode !== "pins") return grounding;
  const next = grounding.documentIds.filter((id) => id !== documentId);
  return next.length > 0 ? { mode: "pins", documentIds: next } : WORKSPACE_GROUNDING;
}

export function hasSearchableLibrary(
  documents: Array<{ status?: string | null; chunkCount?: number | null }>,
): boolean {
  return documents.some((doc) => isUsableLibraryDocument(doc));
}

/** 写入气泡的附件：只记会话文件和收窄钉住的篇，不写 library_all */
export function displayMessageAttachments(input: {
  grounding: LibraryGrounding;
  attachments: MessageAttachment[];
  documents: Array<{ id: string; name: string }>;
}): MessageAttachment[] | undefined {
  const files = conversationFileAttachments(input.attachments);
  const pins =
    input.grounding.mode === "pins"
      ? input.grounding.documentIds
          .flatMap((id) => {
            const document = input.documents.find((item) => item.id === id);
            return document
              ? [{ kind: "library" as const, id: document.id, name: document.name }]
              : [];
          })
      : [];
  const items = [...files, ...pins];
  return items.length > 0 ? items : undefined;
}
