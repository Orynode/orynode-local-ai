/**
 * Wiki 页持久化（data-service 薄 CRUD）
 */

import { HTTP_TIMEOUT, ORYNODE_DATA_URL } from "../../../config/defaults";
import type { CompiledWikiPage } from "./compile-document-mirror";
import type { WikiLink } from "./wiki-graph";
import type { WikiDecision } from "./wiki-identity";
import { wikiInternalHeaders } from "./wiki-internal-auth";

/** 列表/点读保持短超时，避免 UI 被慢查询拖住 */
export const WIKI_READ_TIMEOUT_MS = Math.min(HTTP_TIMEOUT.knowledge, 2500);
/** 页写入（upsert/publish/patch）失败抛错。compile_run / build 诊断失败只记日志，避免拖垮主 Job。 */
export const WIKI_WRITE_TIMEOUT_MS = HTTP_TIMEOUT.knowledge;

export class WikiPersistError extends Error {
  readonly op: string;
  readonly status?: number;

  constructor(op: string, detail: string, status?: number) {
    super(`WIKI_PERSIST_${op}:${detail}`);
    this.name = "WikiPersistError";
    this.op = op;
    this.status = status;
  }
}

export type PersistedWikiPage = CompiledWikiPage & {
  createdAt?: string;
  updatedAt?: string;
};

export type WikiLinkList = {
  outgoing: WikiLink[];
  incoming: WikiLink[];
};

function warnPersist(op: string, detail: unknown) {
  console.warn(
    "[wiki] persist",
    op,
    detail instanceof Error ? detail.message : detail,
  );
}

async function wikiFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : input;
  const method = String(init?.method || "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const signed = wikiInternalHeaders(method, url.pathname);
  for (const [key, value] of Object.entries(signed)) {
    headers.set(key, value);
  }
  return fetch(url, { ...init, headers });
}

async function parsePageResponse(
  response: Response,
  op: string,
): Promise<PersistedWikiPage | null> {
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new WikiPersistError(op, `http_${response.status}`, response.status);
  }
  const body = (await response.json()) as { page?: PersistedWikiPage };
  return body.page ?? null;
}

export async function fetchWikiPage(input: {
  namespace: "library" | "conversation";
  sourceDocumentId: string;
}): Promise<PersistedWikiPage | null> {
  try {
    const url = new URL("/wiki/pages", ORYNODE_DATA_URL);
    url.searchParams.set("namespace", input.namespace);
    url.searchParams.set("sourceDocumentId", input.sourceDocumentId);
    const response = await wikiFetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
    });
    return await parsePageResponse(response, "get_by_source");
  } catch (error) {
    if (error instanceof WikiPersistError && error.status === 401) throw error;
    warnPersist("get_by_source", error);
    return null;
  }
}

export async function fetchWikiPageById(
  pageId: string,
): Promise<PersistedWikiPage | null> {
  const id = String(pageId || "").trim();
  if (!id) return null;
  try {
    const response = await wikiFetch(
      `${ORYNODE_DATA_URL}/wiki/pages/${encodeURIComponent(id)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
      },
    );
    return await parsePageResponse(response, "get_by_id");
  } catch (error) {
    if (error instanceof WikiPersistError && error.status === 401) throw error;
    warnPersist("get_by_id", error);
    return null;
  }
}

export async function listWikiPages(input: {
  namespace?: "library" | "conversation";
  kind?: string;
  query?: string;
  limit?: number;
  conversationId?: string;
}): Promise<PersistedWikiPage[]> {
  try {
    const url = new URL("/wiki/pages", ORYNODE_DATA_URL);
    url.searchParams.set("namespace", input.namespace || "library");
    if (input.kind) url.searchParams.set("kind", input.kind);
    if (input.query) url.searchParams.set("q", input.query);
    if (input.limit) url.searchParams.set("limit", String(input.limit));
    if (input.conversationId) {
      url.searchParams.set("conversationId", input.conversationId);
    }
    const response = await wikiFetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnPersist("list", `http_${response.status}`);
      return [];
    }
    const body = (await response.json()) as { pages?: PersistedWikiPage[] };
    return Array.isArray(body.pages) ? body.pages : [];
  } catch (error) {
    warnPersist("list", error);
    return [];
  }
}

export async function searchWikiPages(input: {
  query: string;
  namespace?: "library" | "conversation";
  kind?: string;
  limit?: number;
  conversationId?: string;
}): Promise<PersistedWikiPage[]> {
  return listWikiPages({
    namespace: input.namespace,
    kind: input.kind,
    query: input.query,
    limit: input.limit,
    conversationId: input.conversationId,
  });
}

export async function upsertWikiPage(
  page: CompiledWikiPage,
): Promise<PersistedWikiPage> {
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/pages`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(page),
      signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new WikiPersistError(
        "upsert",
        `http_${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as { page?: PersistedWikiPage };
    if (!body.page) {
      throw new WikiPersistError("upsert", "empty_page", response.status);
    }
    return body.page;
  } catch (error) {
    warnPersist("upsert", error);
    if (error instanceof WikiPersistError) throw error;
    throw new WikiPersistError(
      "upsert",
      error instanceof Error ? error.message : "failed",
    );
  }
}

export async function publishWikiCompilation(input: {
  page: CompiledWikiPage;
  links?: WikiLink[];
  pendingEdges?: WikiPendingEdgeInput[];
}): Promise<PersistedWikiPage> {
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/pages/publish`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new WikiPersistError(
        "publish",
        `http_${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as { page?: PersistedWikiPage };
    if (!body.page) {
      throw new WikiPersistError("publish", "empty_page", response.status);
    }
    return body.page;
  } catch (error) {
    warnPersist("publish", error);
    if (error instanceof WikiPersistError) throw error;
    throw new WikiPersistError(
      "publish",
      error instanceof Error ? error.message : "failed",
    );
  }
}

export async function patchWikiPage(
  pageId: string,
  patch: {
    markdown?: string;
    synthesisMarkdown?: string;
    notesMarkdown?: string;
    ifUpdatedAt?: string;
  },
): Promise<PersistedWikiPage | null> {
  const id = String(pageId || "").trim();
  if (!id) return null;
  try {
    const response = await wikiFetch(
      `${ORYNODE_DATA_URL}/wiki/pages/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
      },
    );
    if (response.status === 404) return null;
    if (response.status === 409) {
      throw new WikiPersistError("patch", "conflict", 409);
    }
    if (!response.ok) {
      throw new WikiPersistError(
        "patch",
        `http_${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as { page?: PersistedWikiPage };
    return body.page ?? null;
  } catch (error) {
    warnPersist("patch", error);
    if (error instanceof WikiPersistError) throw error;
    throw new WikiPersistError(
      "patch",
      error instanceof Error ? error.message : "failed",
    );
  }
}

export async function deleteWikiPage(pageId: string): Promise<boolean> {
  const id = String(pageId || "").trim();
  if (!id) return false;
  try {
    const response = await wikiFetch(
      `${ORYNODE_DATA_URL}/wiki/pages/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      warnPersist("delete", `http_${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    warnPersist("delete", error);
    return false;
  }
}

export async function fetchWikiLinks(pageId: string): Promise<WikiLinkList> {
  const empty: WikiLinkList = { outgoing: [], incoming: [] };
  const id = String(pageId || "").trim();
  if (!id) return empty;
  try {
    const response = await wikiFetch(
      `${ORYNODE_DATA_URL}/wiki/pages/${encodeURIComponent(id)}/links`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
      },
    );
    if (!response.ok) return empty;
    const body = (await response.json()) as Partial<WikiLinkList>;
    return {
      outgoing: Array.isArray(body.outgoing) ? body.outgoing : [],
      incoming: Array.isArray(body.incoming) ? body.incoming : [],
    };
  } catch (error) {
    warnPersist("links", error);
    return empty;
  }
}

export async function replaceWikiLinks(
  pageId: string,
  links: WikiLink[],
): Promise<WikiLink[]> {
  const id = String(pageId || "").trim();
  if (!id) return [];
  try {
    const response = await wikiFetch(
      `${ORYNODE_DATA_URL}/wiki/pages/${encodeURIComponent(id)}/links`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ links }),
        signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new WikiPersistError(
        "replace_links",
        `http_${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as { links?: WikiLink[] };
    return Array.isArray(body.links) ? body.links : links;
  } catch (error) {
    warnPersist("replace_links", error);
    if (error instanceof WikiPersistError) throw error;
    throw new WikiPersistError(
      "replace_links",
      error instanceof Error ? error.message : "failed",
    );
  }
}

export async function recordWikiBuild(input: {
  id: string;
  namespace: "library" | "conversation";
  compiler: string;
  pageCount: number;
  linkCount: number;
}): Promise<boolean> {
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/builds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnPersist("record_build", `http_${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    warnPersist("record_build", error);
    return false;
  }
}

export type WikiCompileRunInput = {
  id: string;
  pageId: string;
  compiler: string;
  status: "published" | "failed";
  attempts: number;
  repaired?: boolean;
  errorCode?: string;
  inputHash?: string;
  sectionCount?: number;
  batchCount?: number;
  claimCount?: number;
  tokenIn?: number;
  durationMs?: number;
};

export async function recordWikiCompileRun(
  input: WikiCompileRunInput,
): Promise<boolean> {
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/compile-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnPersist("record_compile_run", `http_${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    warnPersist("record_compile_run", error);
    return false;
  }
}

export type WikiPendingEdgeInput = {
  target: string;
  rel: string;
  citationSectionIndexes?: number[];
};

export async function listWikiDecisions(): Promise<WikiDecision[]> {
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/decisions`, {
      cache: "no-store",
      signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnPersist("list_decisions", `http_${response.status}`);
      return [];
    }
    const body = (await response.json()) as { decisions?: WikiDecision[] };
    return Array.isArray(body.decisions) ? body.decisions : [];
  } catch (error) {
    warnPersist("list_decisions", error);
    return [];
  }
}

export async function saveWikiDecision(
  input: WikiDecision,
): Promise<WikiDecision | null> {
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new WikiPersistError(
        "save_decision",
        `http_${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as { decision?: WikiDecision };
    return body.decision ?? input;
  } catch (error) {
    warnPersist("save_decision", error);
    if (error instanceof WikiPersistError) throw error;
    throw new WikiPersistError(
      "save_decision",
      error instanceof Error ? error.message : "failed",
    );
  }
}

export async function replaceWikiPendingEdges(
  fromId: string,
  edges: WikiPendingEdgeInput[],
): Promise<WikiPendingEdgeInput[]> {
  const id = String(fromId || "").trim();
  if (!id) return [];
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/pending-edges`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromId: id, edges }),
      signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new WikiPersistError(
        "replace_pending_edges",
        `http_${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as { edges?: WikiPendingEdgeInput[] };
    return Array.isArray(body.edges) ? body.edges : edges;
  } catch (error) {
    warnPersist("replace_pending_edges", error);
    if (error instanceof WikiPersistError) throw error;
    throw new WikiPersistError(
      "replace_pending_edges",
      error instanceof Error ? error.message : "failed",
    );
  }
}

export async function listAllWikiPendingEdges(): Promise<
  Array<WikiPendingEdgeInput & { fromId: string }>
> {
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/pending-edges`, {
      cache: "no-store",
      signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnPersist("list_all_pending_edges", `http_${response.status}`);
      return [];
    }
    const body = (await response.json()) as {
      edges?: Array<WikiPendingEdgeInput & { fromId: string }>;
    };
    return Array.isArray(body.edges) ? body.edges : [];
  } catch (error) {
    warnPersist("list_all_pending_edges", error);
    return [];
  }
}

export type WikiCandidateInput = {
  id: string;
  pageId: string;
  kind?: string;
  status?: string;
  text: string;
  payload?: Record<string, unknown>;
};

export async function saveWikiCandidate(
  input: WikiCandidateInput,
): Promise<WikiCandidateInput> {
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/candidates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new WikiPersistError(
        "save_candidate",
        `http_${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as { candidate?: WikiCandidateInput };
    return body.candidate ?? input;
  } catch (error) {
    warnPersist("save_candidate", error);
    if (error instanceof WikiPersistError) throw error;
    throw new WikiPersistError(
      "save_candidate",
      error instanceof Error ? error.message : "failed",
    );
  }
}

export async function listWikiCandidates(input: {
  pageId: string;
  status?: string;
}): Promise<WikiCandidateInput[]> {
  const pageId = String(input.pageId || "").trim();
  if (!pageId) return [];
  try {
    const url = new URL("/wiki/candidates", ORYNODE_DATA_URL);
    url.searchParams.set("pageId", pageId);
    if (input.status) url.searchParams.set("status", input.status);
    const response = await wikiFetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnPersist("list_candidates", `http_${response.status}`);
      return [];
    }
    const body = (await response.json()) as { candidates?: WikiCandidateInput[] };
    return Array.isArray(body.candidates) ? body.candidates : [];
  } catch (error) {
    warnPersist("list_candidates", error);
    return [];
  }
}

export async function getWikiCandidate(
  id: string,
): Promise<WikiCandidateInput | null> {
  const candidateId = String(id || "").trim();
  if (!candidateId) return null;
  try {
    const url = new URL("/wiki/candidates", ORYNODE_DATA_URL);
    url.searchParams.set("id", candidateId);
    const response = await wikiFetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      warnPersist("get_candidate", `http_${response.status}`);
      return null;
    }
    const body = (await response.json()) as { candidate?: WikiCandidateInput };
    return body.candidate ?? null;
  } catch (error) {
    warnPersist("get_candidate", error);
    return null;
  }
}

export async function patchWikiCandidateStatus(
  id: string,
  status: string,
): Promise<WikiCandidateInput | null> {
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/candidates`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, status }),
      signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnPersist("patch_candidate", `http_${response.status}`);
      return null;
    }
    const body = (await response.json()) as { candidate?: WikiCandidateInput };
    return body.candidate ?? null;
  } catch (error) {
    warnPersist("patch_candidate", error);
    return null;
  }
}

export async function listWikiPendingEdges(
  fromId: string,
): Promise<WikiPendingEdgeInput[]> {
  const id = String(fromId || "").trim();
  if (!id) return [];
  try {
    const url = new URL("/wiki/pending-edges", ORYNODE_DATA_URL);
    url.searchParams.set("fromId", id);
    const response = await wikiFetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnPersist("list_pending_edges", `http_${response.status}`);
      return [];
    }
    const body = (await response.json()) as { edges?: WikiPendingEdgeInput[] };
    return Array.isArray(body.edges) ? body.edges : [];
  } catch (error) {
    warnPersist("list_pending_edges", error);
    return [];
  }
}

export async function markWikiSourceUpdated(
  sourceDocumentId: string,
): Promise<number> {
  return postWikiSourceChanged(sourceDocumentId, "updated");
}

export async function markWikiSourceDeleted(
  sourceDocumentId: string,
): Promise<number> {
  return postWikiSourceChanged(sourceDocumentId, "deleted");
}

async function postWikiSourceChanged(
  sourceDocumentId: string,
  action: "updated" | "deleted",
): Promise<number> {
  const id = String(sourceDocumentId || "").trim();
  if (!id) return 0;
  try {
    const response = await wikiFetch(`${ORYNODE_DATA_URL}/wiki/source-changed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        namespace: "library",
        sourceDocumentId: id,
        action,
      }),
      signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnPersist(`source_${action}`, `http_${response.status}`);
      return 0;
    }
    const body = (await response.json()) as {
      stale?: number;
      dropped?: number;
      updated?: number;
      deleted?: number;
    };
    if (action === "deleted") {
      return (
        Number(body.dropped || 0) +
        Number(body.updated || 0) +
        Number(body.deleted || 0)
      );
    }
    return Number(body.stale) || 0;
  } catch (error) {
    warnPersist(`source_${action}`, error);
    return 0;
  }
}

export type WikiCompileRunRecord = {
  id: string;
  pageId: string;
  compiler: string;
  status: string;
  attempts: number;
  repaired?: boolean;
  errorCode?: string;
  createdAt?: string;
};

export async function listWikiCompileRuns(
  pageId: string,
): Promise<WikiCompileRunRecord[]> {
  const id = String(pageId || "").trim();
  if (!id) return [];
  try {
    const url = new URL("/wiki/compile-runs", ORYNODE_DATA_URL);
    url.searchParams.set("pageId", id);
    const response = await wikiFetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      warnPersist("list_compile_runs", `http_${response.status}`);
      return [];
    }
    const body = (await response.json()) as { runs?: WikiCompileRunRecord[] };
    return Array.isArray(body.runs) ? body.runs : [];
  } catch (error) {
    warnPersist("list_compile_runs", error);
    return [];
  }
}

export type WikiPageRevision = {
  id: string;
  pageId: string;
  revision: number;
  reason: string;
  createdAt: string;
  userEdited?: boolean;
  excerpt?: string;
};

export async function listWikiRevisions(
  pageId: string,
): Promise<WikiPageRevision[]> {
  const id = String(pageId || "").trim();
  if (!id) return [];
  try {
    const response = await wikiFetch(
      `${ORYNODE_DATA_URL}/wiki/pages/${encodeURIComponent(id)}/revisions`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(WIKI_READ_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      warnPersist("list_revisions", `http_${response.status}`);
      return [];
    }
    const body = (await response.json()) as { revisions?: WikiPageRevision[] };
    return Array.isArray(body.revisions) ? body.revisions : [];
  } catch (error) {
    warnPersist("list_revisions", error);
    return [];
  }
}

export async function restoreWikiRevision(input: {
  pageId: string;
  revision: number;
  ifUpdatedAt?: string;
}): Promise<PersistedWikiPage | null> {
  const id = String(input.pageId || "").trim();
  if (!id) return null;
  try {
    const response = await wikiFetch(
      `${ORYNODE_DATA_URL}/wiki/pages/${encodeURIComponent(id)}/restore`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: input.revision,
          ifUpdatedAt: input.ifUpdatedAt,
        }),
        signal: AbortSignal.timeout(WIKI_WRITE_TIMEOUT_MS),
      },
    );
    if (response.status === 404) return null;
    if (response.status === 409) {
      throw new WikiPersistError("restore", "conflict", 409);
    }
    if (!response.ok) {
      throw new WikiPersistError(
        "restore",
        `http_${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as { page?: PersistedWikiPage };
    return body.page ?? null;
  } catch (error) {
    warnPersist("restore", error);
    if (error instanceof WikiPersistError) throw error;
    throw new WikiPersistError(
      "restore",
      error instanceof Error ? error.message : "failed",
    );
  }
}
