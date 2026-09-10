/**
 * P1 概念身份：稳定 ID、别名、消歧、人工合并/拆分。
 * LLM 只提议别名；最终解析必须确定性。
 */

import type { TerminologyEntry } from "../query/terminology";
import type {
  WikiConceptIdentity,
  WikiSection,
} from "./compile-document-mirror";

export function conceptSlugKey(title: string): string {
  return String(title || "")
    .toLocaleLowerCase()
    .replace(/[\s_\-–—、，。．.：:；;！!？?/\\()（）【】\[\]"'`]+/g, "")
    .slice(0, 80);
}

export type WikiDecisionAction =
  | "merge"
  | "split"
  | "accept"
  | "reject"
  | "undo";

export type WikiDecision = {
  id: string;
  action: WikiDecisionAction;
  actor?: string;
  reason?: string;
  fromKey?: string;
  toKey?: string;
  aliasKey?: string;
  disambiguation?: string;
  documentIds?: string[];
  candidateId?: string;
  settleId?: string;
  pageId?: string;
  reversiblePatch?: {
    pageId?: string;
    notesMarkdown?: string;
    knowledge?: unknown;
  };
  createdAt?: string;
};

export type ConceptCluster = {
  key: string;
  title: string;
  sections: WikiSection[];
  documentIds: Set<string>;
  identity?: WikiConceptIdentity;
};

export function matchLongestTerminology(
  text: string,
  entries: TerminologyEntry[] = [],
): TerminologyEntry | null {
  const hay = String(text || "").toLocaleLowerCase();
  if (hay.length < 2) return null;
  let best: TerminologyEntry | null = null;
  let bestLen = 0;
  for (const entry of entries) {
    const excluded = (entry.exclude ?? []).some((item) => {
      const needle = String(item).toLocaleLowerCase().trim();
      return needle.length >= 2 && hay.includes(needle);
    });
    if (excluded) continue;
    for (const term of entry.terms) {
      const needle = String(term).toLocaleLowerCase().trim();
      if (needle.length < 2 || !hay.includes(needle)) continue;
      if (needle.length > bestLen) {
        best = entry;
        bestLen = needle.length;
      }
    }
  }
  return best;
}

export function resolveCanonicalLabel(
  title: string,
  entries: TerminologyEntry[] = [],
): string {
  const matched = matchLongestTerminology(title, entries);
  const canonical = matched?.terms[0];
  return String(canonical || title).trim() || title.trim();
}

export function conceptIdentityFor(
  title: string,
  entries: TerminologyEntry[] = [],
  options?: { disambiguation?: string; pinned?: boolean },
): WikiConceptIdentity {
  const matched = matchLongestTerminology(title, entries);
  const canonicalTitle = String(matched?.terms[0] || title).trim();
  const aliases = (matched?.terms ?? [])
    .map((term) => String(term).trim())
    .filter((term) => conceptSlugKey(term) !== conceptSlugKey(canonicalTitle));
  const stableId = matched
    ? `term:${matched.id}`
    : `slug:${conceptSlugKey(canonicalTitle)}${options?.disambiguation ? `:${options.disambiguation}` : ""}`;
  return {
    stableId,
    canonicalTitle,
    aliases,
    ...(options?.disambiguation ? { disambiguation: options.disambiguation } : {}),
    ...(options?.pinned ? { pinned: true } : {}),
  };
}

function findClusterKey(
  groups: Map<string, ConceptCluster>,
  needle: string,
): string | null {
  const want = conceptSlugKey(needle);
  if (!want) return null;
  if (groups.has(want)) return want;
  for (const [key, cluster] of groups) {
    const names = [
      cluster.title,
      cluster.identity?.canonicalTitle,
      ...(cluster.identity?.aliases ?? []),
    ].filter((name): name is string => Boolean(name));
    if (names.some((name) => conceptSlugKey(name) === want)) return key;
  }
  return null;
}

export function applyConceptDecisions(
  groups: Map<string, ConceptCluster>,
  decisions: WikiDecision[] = [],
): Map<string, ConceptCluster> {
  const next = new Map(groups);
  for (const decision of decisions) {
    if (decision.action === "merge") {
      const fromKey = findClusterKey(next, decision.fromKey || "");
      const toKey = findClusterKey(next, decision.toKey || "");
      if (!fromKey || !toKey || fromKey === toKey) continue;
      const from = next.get(fromKey);
      const to = next.get(toKey);
      if (!from || !to) continue;
      for (const section of from.sections) to.sections.push(section);
      for (const documentId of from.documentIds) to.documentIds.add(documentId);
      const identity = to.identity || conceptIdentityFor(to.title);
      to.identity = {
        ...identity,
        aliases: [
          ...new Set(
            [...identity.aliases, from.title].filter(
              (alias) =>
                conceptSlugKey(alias) !== conceptSlugKey(identity.canonicalTitle),
            ),
          ),
        ],
        pinned: true,
      };
      next.delete(fromKey);
      continue;
    }
    if (decision.action === "split") {
      const fromKey = findClusterKey(
        next,
        decision.aliasKey || decision.fromKey || "",
      );
      const from = fromKey ? next.get(fromKey) : undefined;
      if (!from) continue;
      const splitDocs = new Set(decision.documentIds ?? []);
      if (splitDocs.size === 0) continue;
      const keptSections = from.sections.filter(
        (section) => !splitDocs.has(String(section.sourceDocumentId || "")),
      );
      const moved = from.sections.filter((section) =>
        splitDocs.has(String(section.sourceDocumentId || "")),
      );
      if (moved.length === 0) continue;
      const disambiguation = String(decision.disambiguation || "split").trim() || "split";
      const splitKey = conceptSlugKey(`${from.title}${disambiguation}`);
      from.sections = keptSections;
      from.documentIds = new Set(
        keptSections
          .map((section) => String(section.sourceDocumentId || ""))
          .filter(Boolean),
      );
      from.identity = {
        ...(from.identity || conceptIdentityFor(from.title)),
        pinned: true,
      };
      next.set(splitKey, {
        key: splitKey,
        title: from.title,
        sections: moved,
        documentIds: splitDocs,
        identity: conceptIdentityFor(from.title, [], {
          disambiguation,
          pinned: true,
        }),
      });
    }
  }
  return next;
}
