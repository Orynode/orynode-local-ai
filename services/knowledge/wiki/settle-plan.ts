/**
 * P3：对话沉淀计划。对准概念/主张；多文档时不广播复制。
 */

import type { CompiledWikiPage } from "./compile-document-mirror";
import { claimFingerprint } from "./compile-synthesis";
import { activeClaims } from "./claim-diff";
import { type WikiSettleTarget } from "./settle-from-chat";
import { conceptSlugKey } from "./wiki-identity";

export type WikiSettlePlan = {
  mode: "concept" | "claim" | "mirror" | "pending";
  target: {
    pageId?: string;
    documentId: string;
    namespace: "library" | "conversation";
    title: string;
  };
  claimId?: string;
  pendingMerge: boolean;
  skippedDocumentIds: string[];
};

export type WikiConceptCatalogEntry = Pick<
  CompiledWikiPage,
  "id" | "title" | "knowledge" | "identity"
>;

function catalogKeys(entry: WikiConceptCatalogEntry): string[] {
  return [
    entry.title,
    ...(entry.identity?.aliases ?? []),
    ...(entry.knowledge?.aliases ?? []),
  ]
    .map((item) => conceptSlugKey(item))
    .filter((item) => item.length >= 2);
}

export function collapseSettleTargets(input: {
  targets: WikiSettleTarget[];
  markdown?: string;
  concepts?: WikiConceptCatalogEntry[];
}): WikiSettlePlan | null {
  const targets = input.targets;
  if (targets.length === 0) return null;
  const skippedDocumentIds = targets.slice(1).map((item) => item.documentId);
  const hay = conceptSlugKey(
    [String(input.markdown || ""), ...targets.map((item) => item.title)].join(" "),
  );
  for (const concept of input.concepts ?? []) {
    const keys = catalogKeys(concept);
    if (!keys.some((key) => hay.includes(key))) continue;
    const claim = activeClaims(concept.knowledge?.claims).find((item) => {
      const fp = item.fingerprint || claimFingerprint(item.text);
      return fp.length >= 8 && hay.includes(fp.slice(0, Math.min(12, fp.length)));
    });
    return {
      mode: claim ? "claim" : "concept",
      target: {
        pageId: concept.id,
        documentId: targets[0]!.documentId,
        namespace: "library",
        title: concept.title,
      },
      claimId: claim?.id,
      pendingMerge: targets.length > 1,
      skippedDocumentIds,
    };
  }
  const primary = targets[0]!;
  return {
    mode: targets.length > 1 ? "pending" : "mirror",
    target: {
      documentId: primary.documentId,
      namespace: primary.namespace,
      title: primary.title,
    },
    pendingMerge: targets.length > 1,
    skippedDocumentIds,
  };
}
