/**
 * 对话附件 ↔ 检索范围
 *
 * ChatGPT 模型：附件只属于「本轮草稿 / 本条消息」，不跟会话粘性绑定。
 */

import type { MessageAttachment } from "../../services/types";
import type { KnowledgeScope } from "../../services/knowledge/types";
import type { KnowledgeDocument } from "../../services/types";

export function scopeFromAttachments(
  attachments: MessageAttachment[] | undefined,
): KnowledgeScope {
  if (!attachments || attachments.length === 0) {
    return { mode: "none" };
  }
  if (attachments.some((item) => item.kind === "all")) {
    return { mode: "all" };
  }
  const documentIds = attachments
    .filter((item) => item.kind === "document")
    .map((item) => item.id);
  if (documentIds.length === 0) {
    return { mode: "none" };
  }
  return { mode: "documents", documentIds };
}

export function attachmentFromDocument(
  document: KnowledgeDocument,
): MessageAttachment {
  return {
    id: document.id,
    name: document.name,
    kind: "document",
  };
}

export function allDocumentsAttachment(): MessageAttachment {
  return {
    id: "all",
    name: "全部资料",
    kind: "all",
  };
}

/** 草稿里切换单篇：若当前是「全部」，先拆成单篇再切换 */
export function toggleDraftDocument(
  draft: MessageAttachment[],
  document: KnowledgeDocument,
): MessageAttachment[] {
  const withoutAll = draft.filter((item) => item.kind !== "all");
  const exists = withoutAll.some((item) => item.id === document.id);
  if (exists) {
    return withoutAll.filter((item) => item.id !== document.id);
  }
  return [...withoutAll, attachmentFromDocument(document)];
}

export function removeDraftAttachment(
  draft: MessageAttachment[],
  id: string,
): MessageAttachment[] {
  return draft.filter((item) => item.id !== id);
}
