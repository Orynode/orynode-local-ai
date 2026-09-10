import type {
  WikiCompileRun,
  WikiHistoryEntry,
  WikiOutlinePage,
  WikiPendingCandidate,
  WikiRelatedPage,
} from "../components/knowledge/WikiOutlineDialog";
import { isSameSourceCluster } from "./wiki-related-cluster";

export type WikiClientAccess = {
  conversationId?: string | null;
  fileId?: string | null;
};

export function wikiAccessQuery(access?: WikiClientAccess): string {
  const params = new URLSearchParams();
  if (access?.conversationId && access.fileId) {
    params.set("conversationId", access.conversationId);
    params.set("fileId", access.fileId);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function wikiLinksQuery(access?: WikiClientAccess): string {
  const params = new URLSearchParams();
  if (access?.conversationId && access.fileId) {
    params.set("conversationId", access.conversationId);
    params.set("fileId", access.fileId);
  }
  params.set("follow", "1");
  return `?${params.toString()}`;
}

export async function fetchWikiPageJson(
  pageId: string,
  access?: WikiClientAccess,
): Promise<WikiOutlinePage | null> {
  const response = await fetch(
    `/api/knowledge/wiki/pages/${encodeURIComponent(pageId)}${wikiAccessQuery(access)}`,
    { cache: "no-store" },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { page?: WikiOutlinePage & { id?: string } };
  if (!body.page) return null;
  return { ...body.page, id: body.page.id || pageId };
}

export async function loadWikiRelatedPages(
  pageId: string,
  access?: WikiClientAccess,
): Promise<WikiRelatedPage[]> {
  const response = await fetch(
    `/api/knowledge/wiki/pages/${encodeURIComponent(pageId)}/links${wikiLinksQuery(access)}`,
    { cache: "no-store" },
  );
  if (!response.ok) return [];
  const body = (await response.json()) as {
    outgoing?: Array<{ fromId: string; toId: string; rel: string }>;
    incoming?: Array<{ fromId: string; toId: string; rel: string }>;
    followed?: Array<{ id?: string; title?: string }>;
  };
  const outgoing = body.outgoing ?? [];
  const incoming = body.incoming ?? [];
  const followed = body.followed ?? [];
  const neighborIds = [
    ...new Set([
      ...outgoing.map((link) => link.toId),
      ...incoming.map((link) => link.fromId),
      ...followed.map((page) => String(page.id || "").trim()),
    ]),
  ].filter((id) => id && id !== pageId);
  const [current, ...neighborPages] = await Promise.all([
    fetchWikiPageJson(pageId, access),
    ...neighborIds.slice(0, 12).map((id) => fetchWikiPageJson(id, access)),
  ]);
  const pageById = new Map<string, WikiOutlinePage>();
  for (const page of neighborPages) {
    if (page?.id) pageById.set(page.id, page);
  }

  const related: WikiRelatedPage[] = [];
  const seen = new Set<string>();
  for (const link of outgoing) {
    const neighbor = pageById.get(link.toId);
    if (!neighbor?.title) continue;
    related.push({
      id: link.toId,
      title: neighbor.title,
      rel: link.rel,
      direction: "outgoing",
    });
    seen.add(link.toId);
  }
  for (const link of incoming) {
    const neighbor = pageById.get(link.fromId);
    if (!neighbor?.title || seen.has(link.fromId)) continue;
    related.push({
      id: link.fromId,
      title: neighbor.title,
      rel: link.rel,
      direction: "incoming",
    });
    seen.add(link.fromId);
  }
  for (const page of followed) {
    const id = page.id;
    const neighbor = id ? pageById.get(id) : undefined;
    const title = neighbor?.title || page.title;
    if (!id || !title || seen.has(id) || id === pageId) continue;
    related.push({
      id,
      title,
      rel: "see_also",
      direction: "outgoing",
    });
    seen.add(id);
  }
  return related
    .filter((item) => {
      if (!current) return false;
      const neighbor = pageById.get(item.id);
      if (!neighbor) return false;
      return !isSameSourceCluster(current, neighbor);
    })
    .slice(0, 12);
}

export async function loadWikiHistory(
  pageId: string,
  access?: WikiClientAccess,
): Promise<WikiHistoryEntry[]> {
  const response = await fetch(
    `/api/knowledge/wiki/pages/${encodeURIComponent(pageId)}/history${wikiAccessQuery(access)}`,
    { cache: "no-store" },
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { revisions?: WikiHistoryEntry[] };
  return Array.isArray(body.revisions) ? body.revisions : [];
}

export async function loadWikiCompileRuns(
  pageId: string,
  access?: WikiClientAccess,
): Promise<WikiCompileRun[]> {
  const response = await fetch(
    `/api/knowledge/wiki/pages/${encodeURIComponent(pageId)}/runs${wikiAccessQuery(access)}`,
    { cache: "no-store" },
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { runs?: WikiCompileRun[] };
  return Array.isArray(body.runs) ? body.runs : [];
}

export async function loadWikiPendingCandidates(
  pageId: string,
  access?: WikiClientAccess,
): Promise<WikiPendingCandidate[]> {
  const params = new URLSearchParams();
  params.set("pageId", pageId);
  params.set("status", "pending");
  if (access?.conversationId && access.fileId) {
    params.set("conversationId", access.conversationId);
    params.set("fileId", access.fileId);
  }
  const response = await fetch(
    `/api/knowledge/wiki/candidates?${params.toString()}`,
    { cache: "no-store" },
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { candidates?: WikiPendingCandidate[] };
  return (body.candidates ?? []).filter((item) => item.status === "pending");
}

export async function reviewWikiPageCandidate(
  id: string,
  action: "accept" | "reject",
  access?: WikiClientAccess,
): Promise<{ page?: WikiOutlinePage }> {
  const response = await fetch(
    `/api/knowledge/wiki/candidates${wikiAccessQuery(access)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    page?: WikiOutlinePage;
  };
  if (!response.ok) {
    throw new Error(body.error || "无法审核候选");
  }
  return body;
}

export async function restoreWikiHistory(
  pageId: string,
  revision: number,
  access?: WikiClientAccess,
  ifUpdatedAt?: string,
): Promise<WikiOutlinePage | null> {
  const response = await fetch(
    `/api/knowledge/wiki/pages/${encodeURIComponent(pageId)}/history${wikiAccessQuery(access)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, ifUpdatedAt }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "无法回滚这一版");
  }
  const body = (await response.json()) as { page?: WikiOutlinePage & { id?: string } };
  if (!body.page) return null;
  return { ...body.page, id: body.page.id || pageId };
}

/** 相关页 / 候选 / 历史 / 编译记录一次拉齐；单项失败不影响其余。 */
export async function loadWikiPageExtras(
  pageId: string,
  access?: WikiClientAccess,
): Promise<{
  related: WikiRelatedPage[];
  candidates: WikiPendingCandidate[];
  history: WikiHistoryEntry[];
  compileRuns: WikiCompileRun[];
}> {
  const [related, candidates, history, compileRuns] = await Promise.all([
    loadWikiRelatedPages(pageId, access).catch(() => [] as WikiRelatedPage[]),
    loadWikiPendingCandidates(pageId, access).catch(() => [] as WikiPendingCandidate[]),
    loadWikiHistory(pageId, access).catch(() => [] as WikiHistoryEntry[]),
    loadWikiCompileRuns(pageId, access).catch(() => [] as WikiCompileRun[]),
  ]);
  return { related, candidates, history, compileRuns };
}

