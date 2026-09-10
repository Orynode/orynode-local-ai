/**
 * Wiki 图：有向边 + 受控 2 跳。
 * Chat / Agent 走页时硬顶跳数与页数，避免把窗口填满。
 */

export type WikiLinkRel =
  | "cites"
  | "see_also"
  | "part_of"
  | "is_a"
  | "depends_on"
  | "causes"
  | "contrasts_with"
  | "related_to";

export type WikiLink = {
  fromId: string;
  toId: string;
  rel: WikiLinkRel;
};

/** Gemma 语义边；概念归并不得整表冲掉 */
export const WIKI_SEMANTIC_RELS: ReadonlySet<WikiLinkRel> = new Set([
  "is_a",
  "part_of",
  "depends_on",
  "causes",
  "contrasts_with",
  "related_to",
]);

/** 概念归并重写的结构边；replace 时只动这两类 */
export const WIKI_CLUSTERING_RELS: ReadonlySet<WikiLinkRel> = new Set([
  "cites",
  "see_also",
]);

export function mergeClusteringOutgoing(
  existing: WikiLink[],
  clustering: WikiLink[],
): WikiLink[] {
  const retained = existing.filter(
    (link) => !WIKI_CLUSTERING_RELS.has(link.rel),
  );
  const seen = new Set(retained.map((link) => `${link.toId}|${link.rel}`));
  const merged = [...retained];
  for (const link of clustering) {
    const key = `${link.toId}|${link.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(link);
  }
  return merged;
}

/** 从当前页出发最多走几跳 */
export const WIKI_FOLLOW_MAX_HOPS = 2;

/** 含起点在内的页数硬顶（对齐 Agent maxOpenChunks） */
export const WIKI_FOLLOW_MAX_PAGES = 8;

export function neighborIds(
  pageId: string,
  links: WikiLink[],
  rel?: WikiLinkRel,
): string[] {
  const out = new Set<string>();
  for (const link of links) {
    if (rel && link.rel !== rel) continue;
    if (link.fromId === pageId) out.add(link.toId);
    if (link.toId === pageId) out.add(link.fromId);
  }
  out.delete(pageId);
  return [...out];
}

/**
 * BFS：最多 `maxHops` 跳，返回不含起点的邻居，总数不超过 maxPages-1。
 */
export function followWikiPages(
  startId: string,
  links: WikiLink[],
  options?: {
    rel?: WikiLinkRel;
    maxHops?: number;
    maxPages?: number;
  },
): string[] {
  const maxHops = options?.maxHops ?? WIKI_FOLLOW_MAX_HOPS;
  const maxPages = options?.maxPages ?? WIKI_FOLLOW_MAX_PAGES;
  const extraCap = Math.max(0, maxPages - 1);
  const ordered: string[] = [];
  const seen = new Set([startId]);
  let frontier = [startId];
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of neighborIds(id, links, options?.rel)) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        ordered.push(neighbor);
        if (ordered.length >= extraCap) return ordered;
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return ordered;
}
