/**
 * Wiki 页读授权：无 Scope 禁止按 pageId 乱读。
 */

import type { CompiledWikiPage } from "./compile-document-mirror";
import type {
  KnowledgeAccessContext,
  ResolvedScope,
  ScopePolicy,
} from "../application/scope-policy";
import type { RetrievalScope } from "../types";

export function wikiPageSourceDocumentIds(page: CompiledWikiPage): string[] {
  const fromSections = page.sections
    .map((section) => String(section.sourceDocumentId || "").trim())
    .filter((id) => id && !id.startsWith("concept:"));
  const root = String(page.sourceDocumentId || "").trim();
  if (root && !root.startsWith("concept:") && page.kind !== "concept") {
    fromSections.unshift(root);
  }
  return [...new Set(fromSections)];
}

export async function canReadWikiPage(
  page: CompiledWikiPage,
  scope: RetrievalScope,
  policy: ScopePolicy,
  _access: KnowledgeAccessContext,
): Promise<boolean> {
  if (scope.mode === "none") return false;

  // 对话沉淀页已下线；旧数据仍可能在库里，检索不再读取。
  if (page.namespace === "conversation" && page.kind === "synthesis") {
    return false;
  }

  // 会话大纲不能靠 library:all 乱读，必须带 conversationFiles。
  if (page.namespace === "conversation") {
    const files = scope.mode === "sources" ? scope.conversationFiles : undefined;
    const documentId = String(page.sourceDocumentId || "").trim();
    if (!files || !documentId) return false;
    return files.fileIds.includes(documentId);
  }

  if (page.kind === "concept") {
    if (scope.library === "all") return true;
    const ids = wikiPageSourceDocumentIds(page);
    if (ids.length === 0) return false;
    for (const documentId of ids) {
      if (await policy.canReadDocument(documentId, scope as ResolvedScope)) return true;
    }
    return false;
  }

  const documentId = page.sourceDocumentId;
  if (!documentId || documentId.startsWith("concept:")) return false;
  return policy.canReadDocument(documentId, scope as ResolvedScope);
}
