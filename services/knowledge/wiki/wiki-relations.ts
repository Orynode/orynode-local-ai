/**
 * P2：语义边解析。无法落到已有概念页的关系保持 pending，禁止凭空造页。
 */

import type { WikiSemanticRelation } from "./compile-document-mirror";
import { conceptSlugKey } from "./wiki-identity";
import type { WikiLink, WikiLinkRel } from "./wiki-graph";

export type WikiRelationCatalogEntry = {
  id: string;
  title: string;
  aliases?: string[];
};

export type ResolvedWikiRelations = {
  resolved: WikiLink[];
  pending: WikiSemanticRelation[];
  relations: WikiSemanticRelation[];
};

const SEMANTIC_RELS = new Set<WikiLinkRel>([
  "is_a",
  "part_of",
  "depends_on",
  "causes",
  "contrasts_with",
  "related_to",
]);

export function identityKey(value: string): string {
  return conceptSlugKey(value);
}

export function resolveWikiRelations(input: {
  fromId: string;
  relations: WikiSemanticRelation[];
  catalog: WikiRelationCatalogEntry[];
}): ResolvedWikiRelations {
  const byIdentity = new Map<string, string>();
  for (const entry of input.catalog) {
    byIdentity.set(identityKey(entry.title), entry.id);
    for (const alias of entry.aliases ?? []) {
      byIdentity.set(identityKey(alias), entry.id);
    }
  }
  const resolved: WikiLink[] = [];
  const pending: WikiSemanticRelation[] = [];
  const relations: WikiSemanticRelation[] = [];
  const seen = new Set<string>();
  for (const relation of input.relations) {
    if (!SEMANTIC_RELS.has(relation.rel as WikiLinkRel)) continue;
    const toId = byIdentity.get(identityKey(relation.target));
    if (!toId || toId === input.fromId) {
      const pendingRel = { ...relation, status: "pending" as const };
      pending.push(pendingRel);
      relations.push(pendingRel);
      continue;
    }
    const key = `${input.fromId}|${toId}|${relation.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({
      fromId: input.fromId,
      toId,
      rel: relation.rel as WikiLinkRel,
    });
    relations.push({
      ...relation,
      status: "resolved",
      resolvedToId: toId,
    });
  }
  return { resolved, pending, relations };
}

export type WikiPendingEdgeRecord = {
  fromId: string;
  target: string;
  rel: string;
  citationSectionIndexes?: number[];
};

export type PromotedWikiEdges = {
  fromId: string;
  resolved: WikiLink[];
  remaining: WikiSemanticRelation[];
};

/** 新概念出现后，把仍 pending 的语义边再解析一遍。 */
export function promotePendingWikiEdges(input: {
  pending: WikiPendingEdgeRecord[];
  catalog: WikiRelationCatalogEntry[];
}): PromotedWikiEdges[] {
  const byFrom = new Map<string, WikiSemanticRelation[]>();
  for (const edge of input.pending) {
    const fromId = String(edge.fromId || "").trim();
    const target = String(edge.target || "").trim();
    if (!fromId || !target) continue;
    const list = byFrom.get(fromId) ?? [];
    list.push({
      target,
      rel: edge.rel as WikiSemanticRelation["rel"],
      citationSectionIndexes: Array.isArray(edge.citationSectionIndexes)
        ? edge.citationSectionIndexes
        : [],
    });
    byFrom.set(fromId, list);
  }
  const promoted: PromotedWikiEdges[] = [];
  for (const [fromId, relations] of byFrom) {
    const resolved = resolveWikiRelations({
      fromId,
      relations,
      catalog: input.catalog,
    });
    promoted.push({
      fromId,
      resolved: resolved.resolved,
      remaining: resolved.pending,
    });
  }
  return promoted;
}
