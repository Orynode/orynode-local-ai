/**
 * P2：主张 diff / 证据绑定 / 源删除撤回。
 */

import type {
  WikiClaim,
  WikiEvidence,
  WikiKnowledge,
  WikiSection,
} from "./compile-document-mirror";
import { claimFingerprint } from "./compile-synthesis";

export function evidenceFromSections(
  sections: WikiSection[],
  indexes: number[],
  fallbackDocumentId = "",
): WikiEvidence[] {
  const out: WikiEvidence[] = [];
  const seen = new Set<string>();
  for (const index of indexes) {
    const section = sections[index - 1];
    if (!section?.chunkId) continue;
    const documentId =
      String(section.sourceDocumentId || fallbackDocumentId || "").trim();
    const key = `${documentId}|${section.chunkId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      documentId,
      chunkId: section.chunkId,
      pageNumber: section.pageNumber,
      ...(section.startLine != null ? { startLine: section.startLine } : {}),
      ...(section.endLine != null ? { endLine: section.endLine } : {}),
    });
  }
  return out;
}

export function bindClaimEvidence(
  claim: WikiClaim,
  sections: WikiSection[],
  fallbackDocumentId = "",
): WikiClaim {
  const evidence =
    claim.evidence && claim.evidence.length > 0
      ? claim.evidence
      : evidenceFromSections(
          sections,
          claim.citationSectionIndexes,
          fallbackDocumentId,
        );
  const sourceChunkIds = [
    ...new Set([
      ...claim.sourceChunkIds,
      ...evidence.map((item) => item.chunkId).filter(Boolean),
    ]),
  ];
  const filled = evidence.map((item) => ({
    ...item,
    documentId: item.documentId || fallbackDocumentId,
  }));
  return {
    ...claim,
    fingerprint: claim.fingerprint || claimFingerprint(claim.text),
    evidence: filled,
    sourceChunkIds,
    status: claim.status || "active",
  };
}

export function bindKnowledgeEvidence(
  knowledge: WikiKnowledge,
  sections: WikiSection[],
  fallbackDocumentId = "",
): WikiKnowledge {
  return {
    ...knowledge,
    claims: knowledge.claims.map((claim) =>
      bindClaimEvidence(claim, sections, fallbackDocumentId),
    ),
  };
}

function evidenceKey(item: WikiEvidence): string {
  return `${item.documentId}|${item.chunkId}`;
}

function sharesEvidence(left: WikiClaim, right: WikiClaim): boolean {
  const rightKeys = new Set(
    (right.evidence ?? []).map(evidenceKey).filter((key) => !key.startsWith("|")),
  );
  if (rightKeys.size === 0) {
    const chunks = new Set(right.sourceChunkIds);
    return left.sourceChunkIds.some((id) => chunks.has(id));
  }
  return (left.evidence ?? []).some((item) => rightKeys.has(evidenceKey(item)));
}

function mergeEvidence(
  previous: WikiEvidence[] = [],
  next: WikiEvidence[] = [],
): WikiEvidence[] {
  const seen = new Set<string>();
  const out: WikiEvidence[] = [];
  for (const item of [...previous, ...next]) {
    const key = evidenceKey(item);
    if (!item.chunkId || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function diffWikiClaims(
  previous: WikiClaim[] = [],
  next: WikiClaim[] = [],
): WikiClaim[] {
  const prevByFp = new Map<string, WikiClaim>();
  for (const claim of previous) {
    prevByFp.set(claim.fingerprint || claimFingerprint(claim.text), claim);
  }
  const used = new Set<string>();
  const out: WikiClaim[] = [];
  for (const claim of next) {
    const fingerprint = claim.fingerprint || claimFingerprint(claim.text);
    const prev = prevByFp.get(fingerprint);
    used.add(fingerprint);
    if (prev) {
      out.push({
        ...claim,
        id: prev.id,
        fingerprint,
        status: "active",
        evidence: mergeEvidence(prev.evidence, claim.evidence),
        sourceChunkIds: [
          ...new Set([...prev.sourceChunkIds, ...claim.sourceChunkIds]),
        ],
      });
      continue;
    }
    const conflict = previous.find(
      (item) =>
        item.status !== "withdrawn" &&
        (item.fingerprint || claimFingerprint(item.text)) !== fingerprint &&
        sharesEvidence(item, claim),
    );
    out.push({
      ...claim,
      fingerprint,
      status: conflict ? "conflicted" : "active",
    });
  }
  for (const prev of previous) {
    const fingerprint = prev.fingerprint || claimFingerprint(prev.text);
    if (used.has(fingerprint)) continue;
    out.push({
      ...prev,
      fingerprint,
      status: "withdrawn",
    });
  }
  return out;
}

export function stripSourceFromKnowledge(
  knowledge: WikiKnowledge | undefined,
  sourceDocumentId: string,
  droppedChunkIds: Set<string> = new Set(),
): WikiKnowledge | undefined {
  if (!knowledge) return knowledge;
  const id = String(sourceDocumentId || "").trim();
  const claims = knowledge.claims.map((claim) => {
    const evidence = (claim.evidence ?? []).filter(
      (item) => item.documentId !== id && !droppedChunkIds.has(item.chunkId),
    );
    const sourceChunkIds = claim.sourceChunkIds.filter(
      (chunkId) => !droppedChunkIds.has(chunkId),
    );
    const empty = evidence.length === 0 && sourceChunkIds.length === 0;
    return {
      ...claim,
      evidence,
      sourceChunkIds,
      status: empty ? ("withdrawn" as const) : claim.status,
    };
  });
  const relations = knowledge.relations.filter((relation) => {
    if (relation.resolvedToId && relation.resolvedToId.includes(id)) return false;
    return true;
  });
  return { ...knowledge, claims, relations };
}

export function activeClaims(claims: WikiClaim[] = []): WikiClaim[] {
  return claims.filter(
    (claim) => !claim.status || claim.status === "active",
  );
}
