/**
 * Context token packing：完整项装箱、文档多样性、邻块扩展
 */

import { estimateTokens } from "../../chat/context";
import type { Citation } from "../core/types";
import type { RetrievalHit } from "../types";

export const KNOWLEDGE_OMISSION_MARK = "…[截断]";

/** 按文档轮询，降低同一文档垄断上下文的概率 */
export function diversifyHits(hits: RetrievalHit[]): RetrievalHit[] {
  if (hits.length <= 1) return hits.slice();

  const byDoc = new Map<string, RetrievalHit[]>();
  for (const hit of hits) {
    const list = byDoc.get(hit.documentId) ?? [];
    list.push(hit);
    byDoc.set(hit.documentId, list);
  }

  const queues = [...byDoc.values()];
  const out: RetrievalHit[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (!next) continue;
      out.push(next);
      progressed = true;
    }
  }
  return out;
}

/** 在候选集中找同文档、同 revision、相邻 position 的邻块（不含已选） */
export function findNeighborHits(
  selected: RetrievalHit[],
  candidates: RetrievalHit[],
): RetrievalHit[] {
  const selectedIds = new Set(selected.map((h) => h.id));
  const byKey = new Map<string, RetrievalHit>();
  for (const hit of candidates) {
    byKey.set(neighborKey(hit), hit);
  }

  const neighbors: RetrievalHit[] = [];
  const seen = new Set<string>();
  for (const hit of selected) {
    for (const delta of [-1, 1] as const) {
      const key = neighborKey({
        ...hit,
        position: hit.position + delta,
      });
      const neighbor = byKey.get(key);
      if (!neighbor || selectedIds.has(neighbor.id) || seen.has(neighbor.id)) {
        continue;
      }
      if (
        (hit.revisionId ?? "legacy") !== (neighbor.revisionId ?? "legacy")
      ) {
        continue;
      }
      seen.add(neighbor.id);
      neighbors.push(neighbor);
    }
  }
  return neighbors;
}

function neighborKey(hit: Pick<RetrievalHit, "documentId" | "position" | "revisionId">): string {
  return `${hit.documentId}\0${hit.revisionId ?? "legacy"}\0${hit.position}`;
}

export function truncateChunkForBudget(
  content: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: "", truncated: true };
  if (estimateTokens(content) <= maxTokens) {
    return { text: content, truncated: false };
  }
  const mark = KNOWLEDGE_OMISSION_MARK;
  const markTokens = estimateTokens(mark);
  const bodyBudget = Math.max(1, maxTokens - markTokens);
  const maxChars = Math.max(1, bodyBudget * 2);

  // 优先在句号/换行处切断，避免切断 [S#] 类标记
  let cut = content.slice(0, maxChars);
  const soft = Math.max(
    cut.lastIndexOf("\n"),
    cut.lastIndexOf("。"),
    cut.lastIndexOf(". "),
    cut.lastIndexOf("！"),
    cut.lastIndexOf("？"),
  );
  if (soft > maxChars * 0.5) {
    cut = cut.slice(0, soft + 1);
  }
  return { text: `${cut.trimEnd()}${mark}`, truncated: true };
}

export function formatCitationBlock(
  citation: Citation,
  content: string,
): string {
  const tag =
    citation.sourceType === "conversation_file" ? "本对话附件" : "资料库";
  const location = formatLocatorLabel(citation);
  return `[${citation.id}] (${tag} · ${citation.title}，${location})\n${content}`;
}

function formatLocatorLabel(citation: Citation): string {
  const locator = citation.locator;
  if (locator.kind === "page") {
    const range =
      locator.startOffset != null && locator.endOffset != null
        ? `，字符 ${locator.startOffset}-${locator.endOffset}`
        : "";
    return `第 ${locator.page} 页${range}`;
  }
  if (locator.kind === "markdown") {
    const heading = locator.headingPath?.length
      ? locator.headingPath.join(" / ")
      : citation.title;
    const lines =
      locator.startLine != null && locator.endLine != null
        ? ` L${locator.startLine}-${locator.endLine}`
        : "";
    return `${heading}${lines}`;
  }
  if (locator.kind === "web") {
    return locator.headingPath?.length
      ? locator.headingPath.join(" / ")
      : locator.url;
  }
  if (locator.kind === "code") {
    return `${locator.path}:${locator.startLine}-${locator.endLine}`;
  }
  if (locator.kind === "text") {
    return `偏移 ${locator.startOffset}-${locator.endOffset}`;
  }
  return "原文";
}

export function estimateBlockTokens(block: string): number {
  return estimateTokens(block) + 2;
}
