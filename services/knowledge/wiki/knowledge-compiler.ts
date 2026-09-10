/**
 * 知识编译器：token 装箱 → 分批抽 claim → 去重 reduce → 成文。
 * 失败抛错，不写库。
 */

import { createHash } from "node:crypto";
import { estimateTokens } from "../../chat/context";
import type { WikiClaim, WikiEvidence, WikiSection } from "./compile-document-mirror";
import {
  buildRepairUserPrompt,
  buildSynthesisUserPrompt,
  claimFingerprint,
  WIKI_MAX_ALIASES,
  WIKI_MAX_CLAIMS,
  WIKI_MAX_RELATIONS,
  WIKI_SYNTHESIS_MIN_CHARS,
  WIKI_SYNTHESIS_SYSTEM_PROMPT,
  type CompiledWikiKnowledge,
} from "./compile-synthesis";
import { packWikiSections, type WikiPackResult } from "./context-packer";
import {
  completeStructuredWikiKnowledge,
  type StructuredCompleteFn,
} from "./structured-completion";

export type WikiCompileDiagnostics = {
  compiler: string;
  inputHash: string;
  attempts: number;
  repaired: boolean;
  batchCount: number;
  sectionCount: number;
  droppedSections: number;
  claimCount: number;
  tokenIn: number;
  durationMs: number;
};

export type WikiCompileResult = {
  compiled: CompiledWikiKnowledge;
  pack: WikiPackResult;
  diagnostics: WikiCompileDiagnostics;
};

export function wikiInputHash(input: {
  title: string;
  kind: string;
  sections: WikiSection[];
}): string {
  const payload = JSON.stringify({
    title: input.title,
    kind: input.kind,
    sections: input.sections.map((section) => [
      section.chunkId,
      section.heading,
      section.excerpt.slice(0, 80),
    ]),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export function reduceCompiledKnowledge(
  parts: CompiledWikiKnowledge[],
): CompiledWikiKnowledge {
  if (parts.length === 0) throw new Error("WIKI_KNOWLEDGE_NO_CLAIMS");
  if (parts.length === 1) return parts[0]!;

  const aliases = [
    ...new Set(parts.flatMap((part) => part.knowledge.aliases)),
  ].slice(0, WIKI_MAX_ALIASES);

  const claims: WikiClaim[] = [];
  const seen = new Map<string, WikiClaim>();
  for (const part of parts) {
    for (const claim of part.knowledge.claims) {
      const key = claim.fingerprint || claimFingerprint(claim.text);
      const existing = seen.get(key);
      if (!existing) {
        const next = { ...claim, fingerprint: key };
        seen.set(key, next);
        claims.push(next);
        continue;
      }
      existing.citationSectionIndexes = [
        ...new Set([
          ...existing.citationSectionIndexes,
          ...claim.citationSectionIndexes,
        ]),
      ].sort((a, b) => a - b);
      existing.sourceChunkIds = [
        ...new Set([...existing.sourceChunkIds, ...claim.sourceChunkIds]),
      ];
      existing.evidence = mergeWikiEvidence(existing.evidence, claim.evidence);
    }
  }
  if (claims.length === 0) throw new Error("WIKI_KNOWLEDGE_NO_CLAIMS");

  const relations = [];
  const seenRel = new Set<string>();
  for (const part of parts) {
    for (const relation of part.knowledge.relations) {
      const key = `${relation.rel}|${relation.target}`;
      if (seenRel.has(key)) continue;
      seenRel.add(key);
      relations.push(relation);
    }
  }

  const articleMarkdown = parts
    .map((part) => part.articleMarkdown.trim())
    .filter(Boolean)
    .join("\n\n");
  if (articleMarkdown.length < WIKI_SYNTHESIS_MIN_CHARS) {
    throw new Error("WIKI_SYNTHESIS_TOO_SHORT");
  }

  return {
    articleMarkdown,
    knowledge: {
      aliases,
      claims: claims.slice(0, WIKI_MAX_CLAIMS).map((claim, index) => ({
        ...claim,
        id: `claim-${index + 1}`,
      })),
      relations: relations.slice(0, WIKI_MAX_RELATIONS),
    },
  };
}

function evidenceKey(item: WikiEvidence): string {
  return [
    item.documentId,
    item.chunkId,
    item.pageNumber ?? "",
    item.startLine ?? "",
    item.endLine ?? "",
  ].join("|");
}

export function mergeWikiEvidence(
  left: WikiEvidence[] | undefined,
  right: WikiEvidence[] | undefined,
): WikiEvidence[] {
  const merged: WikiEvidence[] = [];
  const seen = new Set<string>();
  for (const item of [...(left ?? []), ...(right ?? [])]) {
    const chunkId = String(item.chunkId || "").trim();
    if (!chunkId) continue;
    const next: WikiEvidence = {
      documentId: String(item.documentId || ""),
      chunkId,
      ...(item.pageNumber != null ? { pageNumber: item.pageNumber } : {}),
      ...(item.startLine != null ? { startLine: item.startLine } : {}),
      ...(item.endLine != null ? { endLine: item.endLine } : {}),
    };
    const key = evidenceKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(next);
  }
  return merged;
}

export async function compileWikiKnowledge(input: {
  title: string;
  kind: string;
  sections: WikiSection[];
  compiler: string;
  complete: StructuredCompleteFn;
  onProgress?: (progress: Record<string, unknown>) => void;
}): Promise<WikiCompileResult> {
  const started = Date.now();
  const pack = packWikiSections(input.sections);
  if (pack.sections.length === 0) {
    throw new Error("WIKI_KNOWLEDGE_NO_CLAIMS");
  }
  input.onProgress?.({
    phase: "packing",
    batches: pack.batches.length,
    sections: pack.sections.length,
    dropped: pack.dropped,
  });

  const parts: CompiledWikiKnowledge[] = [];
  let attempts = 0;
  let repaired = false;
  let tokenIn = 0;

  for (const batch of pack.batches) {
    input.onProgress?.({
      phase: "synthesizing",
      batch: batch.batchIndex + 1,
      totalBatches: pack.batches.length,
    });
    const user = buildSynthesisUserPrompt({
      title: input.title,
      sections: batch.sections,
      kind: input.kind,
    });
    tokenIn += estimateTokens(WIKI_SYNTHESIS_SYSTEM_PROMPT) + estimateTokens(user);
    const result = await completeStructuredWikiKnowledge({
      complete: input.complete,
      system: WIKI_SYNTHESIS_SYSTEM_PROMPT,
      user,
      sections: input.sections,
      allowedCitationIndexes: batch.sections.map((section) => section.globalIndex),
      buildRepairUser: buildRepairUserPrompt,
    });
    attempts += result.attempts;
    repaired = repaired || result.repaired;
    if (result.repaired) {
      tokenIn += estimateTokens(WIKI_SYNTHESIS_SYSTEM_PROMPT);
    }
    parts.push(result.compiled);
  }

  const compiled = reduceCompiledKnowledge(parts);
  return {
    compiled,
    pack,
    diagnostics: {
      compiler: input.compiler,
      inputHash: wikiInputHash({
        title: input.title,
        kind: input.kind,
        sections: pack.sections,
      }),
      attempts,
      repaired,
      batchCount: pack.batches.length,
      sectionCount: pack.sections.length,
      droppedSections: pack.dropped,
      claimCount: compiled.knowledge.claims.length,
      tokenIn,
      durationMs: Date.now() - started,
    },
  };
}
