/**
 * 把回答写进一篇大纲页的对话笔记。不覆盖综述，不调用 Gemma。
 * 多源引用由 settle-plan 收成单一目标；可用 settleId 撤销。
 */

import { randomUUID } from "node:crypto";
import { loadOrCompileDocumentMirror } from "./ensure-document-mirror";
import {
  fetchWikiPageById,
  patchWikiPage,
  WikiPersistError,
  type PersistedWikiPage,
} from "./persist";
import {
  lastSettleId,
  settleIdForBody,
  settleMarker,
} from "./settle-markers";

export { settleMarker, stripSettleMarkers } from "./settle-markers";

export type WikiSettleRequestTarget = {
  pageId?: string;
  documentId?: string;
  namespace?: "library" | "conversation";
  title?: string;
};

export type WikiSettledPage = {
  page: PersistedWikiPage;
  documentId: string;
  namespace: "library" | "conversation";
  settleId: string;
  pendingMerge?: boolean;
};

export const WIKI_NOTES_HEADING = "## 对话沉淀";
export const WIKI_SETTLE_BODY_MAX_CHARS = 8_000;
export const WIKI_NOTES_MAX_CHARS = 48_000;
const WIKI_SETTLE_CAS_ATTEMPTS = 3;

function existingNoteBodies(existing: string): string[] {
  const bodies: string[] = [];
  const marked = /<!--orynode-settle:[^>]+-->\n([\s\S]*?)<!--\/orynode-settle:[^>]+-->/g;
  let match: RegExpExecArray | null;
  while ((match = marked.exec(existing))) {
    const body = String(match[1] || "").trim();
    if (body) bodies.push(body);
  }
  const headingBlocks = existing.split(/\n### /).slice(1);
  for (const block of headingBlocks) {
    const text = block.replace(/^[^\n]+\n+/, "").trim();
    const unmarked = text
      .replace(/<!--\/?orynode-settle:[^>]+-->/g, "")
      .trim();
    if (unmarked) bodies.push(unmarked);
  }
  return bodies;
}

export function appendWikiNotes(
  existing: string | undefined,
  addition: string,
  at = new Date().toISOString(),
  settleId?: string,
): string {
  const body = String(addition || "").trim();
  const prev = String(existing || "").trim();
  if (!body) return prev;
  if (body.length > WIKI_SETTLE_BODY_MAX_CHARS) {
    throw new Error("沉淀正文过长");
  }
  if (existingNoteBodies(prev).includes(body)) return prev;
  const stamp = at.slice(0, 16).replace("T", " ");
  const marked = settleId
    ? `${settleMarker(settleId)}\n${body}\n<!--/orynode-settle:${settleId}-->`
    : body;
  const block = `### ${stamp}\n\n${marked}`;
  const next = !prev ? `${WIKI_NOTES_HEADING}\n\n${block}` : `${prev}\n\n${block}`;
  if (next.length > WIKI_NOTES_MAX_CHARS) {
    throw new Error("百科笔记已满，请先清理或撤销旧沉淀");
  }
  return next;
}

export function removeSettleNote(
  existing: string | undefined,
  settleId: string,
): string {
  const prev = String(existing || "");
  const id = String(settleId || "").trim();
  if (!id || !prev.includes(settleMarker(id))) return prev;
  const pattern = new RegExp(
    `\\n*### [^\\n]+\\n\\n${settleMarker(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?<!--/orynode-settle:${id}-->`,
  );
  return prev.replace(pattern, "").trim();
}

export function normalizeSettleTargets(input: {
  pageId?: string;
  documentId?: string;
  namespace?: "library" | "conversation";
  targets?: WikiSettleRequestTarget[];
}): WikiSettleRequestTarget[] {
  if (Array.isArray(input.targets) && input.targets.length > 0) {
    return input.targets;
  }
  if (input.pageId || input.documentId) {
    return [
      {
        pageId: input.pageId,
        documentId: input.documentId,
        namespace: input.namespace,
      },
    ];
  }
  return [];
}

export async function settleWikiPages(input: {
  markdown: string;
  targets: WikiSettleRequestTarget[];
  fetchPageById?: typeof fetchWikiPageById;
  loadMirror?: typeof loadOrCompileDocumentMirror;
  patchPage?: typeof patchWikiPage;
  now?: string;
  settleId?: string;
  pendingMerge?: boolean;
}): Promise<WikiSettledPage[]> {
  const markdown = String(input.markdown || "").trim();
  if (!markdown) {
    throw new Error("没有可沉淀的正文");
  }
  if (markdown.length > WIKI_SETTLE_BODY_MAX_CHARS) {
    throw new Error("沉淀正文过长");
  }
  const fetchPageById = input.fetchPageById ?? fetchWikiPageById;
  const loadMirror = input.loadMirror ?? loadOrCompileDocumentMirror;
  const patchPage = input.patchPage ?? patchWikiPage;
  const settled: WikiSettledPage[] = [];
  const seen = new Set<string>();
  const settleId = String(input.settleId || randomUUID());

  for (const target of input.targets) {
    const pageId = String(target.pageId || "").trim();
    const documentId = String(target.documentId || "").trim();
    const namespace =
      target.namespace === "conversation" ? "conversation" : "library";
    const key = `${namespace}:${pageId || documentId}`;
    if (!pageId && !documentId) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    const written = await settleOnePage({
      pageId,
      documentId,
      namespace,
      markdown,
      settleId,
      pendingMerge: input.pendingMerge,
      now: input.now,
      fetchPageById,
      loadMirror,
      patchPage,
    });
    if (written) settled.push(written);
  }
  if (settled.length === 0) {
    throw new Error("还没有可沉淀的大纲页，请先打开大纲");
  }
  return settled;
}

async function settleOnePage(input: {
  pageId: string;
  documentId: string;
  namespace: "library" | "conversation";
  markdown: string;
  settleId: string;
  pendingMerge?: boolean;
  now?: string;
  fetchPageById: typeof fetchWikiPageById;
  loadMirror: typeof loadOrCompileDocumentMirror;
  patchPage: typeof patchWikiPage;
}): Promise<WikiSettledPage | null> {
  for (let attempt = 0; attempt < WIKI_SETTLE_CAS_ATTEMPTS; attempt += 1) {
    let page = input.pageId ? await input.fetchPageById(input.pageId) : null;
    if (!page && input.documentId) {
      page = await input.loadMirror({
        namespace: input.namespace,
        documentId: input.documentId,
      });
    }
    if (!page) return null;
    const notesMarkdown = appendWikiNotes(
      page.notesMarkdown,
      input.markdown,
      input.now,
      input.settleId,
    );
    const previous = String(page.notesMarkdown || "").trim();
    if (notesMarkdown === previous) {
      return {
        page,
        documentId: input.documentId || page.sourceDocumentId || page.id,
        namespace:
          page.namespace === "conversation" ? "conversation" : input.namespace,
        settleId:
          settleIdForBody(previous, input.markdown) ||
          lastSettleId(previous) ||
          input.settleId,
        pendingMerge: input.pendingMerge,
      };
    }
    try {
      const stored = await input.patchPage(page.id, {
        notesMarkdown,
        ifUpdatedAt: page.updatedAt,
      });
      if (!stored) return null;
      return {
        page: stored,
        documentId: input.documentId || stored.sourceDocumentId,
        namespace:
          stored.namespace === "conversation" ? "conversation" : input.namespace,
        settleId: input.settleId,
        pendingMerge: input.pendingMerge,
      };
    } catch (error) {
      const conflict =
        error instanceof WikiPersistError && error.status === 409;
      if (!conflict || attempt === WIKI_SETTLE_CAS_ATTEMPTS - 1) throw error;
    }
  }
  return null;
}

export async function undoWikiSettle(input: {
  settleId: string;
  pageId?: string;
  fetchPageById?: typeof fetchWikiPageById;
  patchPage?: typeof patchWikiPage;
}): Promise<PersistedWikiPage | null> {
  const settleId = String(input.settleId || "").trim();
  const pageId = String(input.pageId || "").trim();
  if (!settleId || !pageId) return null;
  const fetchPageById = input.fetchPageById ?? fetchWikiPageById;
  const page = await fetchPageById(pageId);
  if (!page) return null;
  const notesMarkdown = removeSettleNote(page.notesMarkdown, settleId);
  if (notesMarkdown === (page.notesMarkdown || "").trim()) {
    return page;
  }
  const patchPage = input.patchPage ?? patchWikiPage;
  return patchPage(page.id, { notesMarkdown });
}
