import type { WikiOutlineSection } from "../components/knowledge/WikiOutlineDialog";
import { wikiAccessQuery, type WikiClientAccess } from "./wiki-related";

const WIKI_COMPILE_ACTIVE = new Set(["queued", "running", "retry_wait"]);

export type WikiLibraryRef = { id: string; name: string };

export type WikiConversationFileRef = {
  id: string;
  name: string;
  conversationId?: string | null;
};

export type WikiCompileJobLike = {
  type: string;
  status: string;
  documentId?: string | null;
  payload?: Record<string, unknown>;
};

export type WikiCompileTarget = {
  page: {
    id?: string;
    namespace?: "library" | "conversation";
    sourceDocumentId?: string;
  };
  conversationId?: string | null;
  fileId?: string | null;
  libraryDocumentId?: string | null;
};

export type WikiSourcePreview = {
  documentId: string;
  sourceType: "conversation_file" | "library";
  conversationId?: string | null;
  title: string;
  page: number;
  startLine?: number;
  endLine?: number;
};

/** 会话页带 conversationId；fileId 优先用附件，否则用页上的 sourceDocumentId。 */
export function wikiSessionAccess(input: {
  conversationId?: string | null;
  fileId?: string | null;
  pageNamespace?: "library" | "conversation";
  pageSourceDocumentId?: string | null;
}): WikiClientAccess | undefined {
  if (
    !input.conversationId ||
    !(input.fileId || input.pageNamespace === "conversation")
  ) {
    return undefined;
  }
  return {
    conversationId: input.conversationId,
    fileId: input.fileId || input.pageSourceDocumentId || "",
  };
}

/**
 * 生成综述 POST 地址。会话附件页走 conversations；资料库篇走 knowledge/:id；
 * 其余（概念页、settle 打开的资料页）走 pages/:id。
 */
export function wikiCompileRequestUrl(target: WikiCompileTarget): string {
  const conversationUrl =
    target.fileId &&
    target.conversationId &&
    target.page.namespace === "conversation" &&
    (target.page.sourceDocumentId === target.fileId ||
      !target.page.sourceDocumentId)
      ? `/api/conversations/${encodeURIComponent(target.conversationId)}/files/${encodeURIComponent(target.fileId)}/wiki`
      : null;
  if (conversationUrl) return conversationUrl;
  if (target.libraryDocumentId) {
    return `/api/knowledge/${encodeURIComponent(target.libraryDocumentId)}/wiki`;
  }
  return `/api/knowledge/wiki/pages/${encodeURIComponent(target.page.id || "")}${wikiAccessQuery(
    wikiSessionAccess({
      conversationId: target.conversationId,
      fileId: target.fileId,
      pageNamespace: target.page.namespace,
      pageSourceDocumentId: target.page.sourceDocumentId,
    }),
  )}`;
}

export function wikiCompileJobMatches(
  job: WikiCompileJobLike,
  target: {
    pageId?: string | null;
    sourceDocumentId?: string | null;
    fileId?: string | null;
    libraryDocumentId?: string | null;
  },
): boolean {
  if (job.type !== "compile_wiki" || !WIKI_COMPILE_ACTIVE.has(job.status)) {
    return false;
  }
  const payloadPageId =
    typeof job.payload?.pageId === "string" ? job.payload.pageId : "";
  return Boolean(
    (target.pageId && payloadPageId === target.pageId) ||
      (target.sourceDocumentId &&
        job.documentId === target.sourceDocumentId) ||
      (target.fileId && job.documentId === target.fileId) ||
      (target.libraryDocumentId && job.documentId === target.libraryDocumentId),
  );
}

export function wikiSourcePreviewIntent(input: {
  section: WikiOutlineSection;
  page: {
    namespace?: "library" | "conversation";
    sourceDocumentId?: string;
    title?: string;
  } | null;
  conversationFile?: WikiConversationFileRef | null;
  conversationId?: string | null;
  libraryDocument?: WikiLibraryRef | null;
  documents?: Array<{ id: string; name: string }>;
}): WikiSourcePreview | null {
  const documentId =
    input.section.sourceDocumentId ||
    input.libraryDocument?.id ||
    input.conversationFile?.id ||
    input.page?.sourceDocumentId;
  if (!documentId) return null;
  const conversationSource =
    input.page?.namespace === "conversation" &&
    (!input.section.sourceDocumentId ||
      input.section.sourceDocumentId === input.conversationFile?.id ||
      input.section.sourceDocumentId === input.page?.sourceDocumentId);
  const title =
    input.section.sourceDocumentTitle ||
    input.documents?.find((doc) => doc.id === documentId)?.name ||
    input.libraryDocument?.name ||
    input.conversationFile?.name ||
    input.page?.title ||
    documentId;
  return {
    documentId,
    sourceType: conversationSource ? "conversation_file" : "library",
    conversationId: conversationSource
      ? input.conversationFile?.conversationId || input.conversationId
      : undefined,
    title,
    page: input.section.pageNumber || 1,
    startLine: input.section.startLine,
    endLine: input.section.endLine,
  };
}
