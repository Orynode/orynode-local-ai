/**
 * 编译结果发布：校验通过才把页写入存储；失败保留上一成功版本。
 * 生产路径用 persist.publishWikiCompilation（页 + 边同一事务）。
 * 单测可注入 upsertPage，只断言页体，不打 HTTP、不写图。
 */

import type { CompiledWikiPage, WikiSection } from "./compile-document-mirror";
import {
  WIKI_SYNTHESIS_MIN_CHARS,
  type CompiledWikiKnowledge,
} from "./compile-synthesis";
import {
  bindKnowledgeEvidence,
  diffWikiClaims,
} from "./claim-diff";

export function assertPublishableKnowledge(
  compiled: CompiledWikiKnowledge,
  sections: WikiSection[],
): void {
  if (compiled.articleMarkdown.trim().length < WIKI_SYNTHESIS_MIN_CHARS) {
    throw new Error("WIKI_SYNTHESIS_TOO_SHORT");
  }
  const claims = compiled.knowledge.claims.filter(
    (claim) => !claim.status || claim.status === "active",
  );
  if (claims.length === 0) throw new Error("WIKI_KNOWLEDGE_NO_CLAIMS");
  for (const claim of claims) {
    const hasChunk =
      claim.sourceChunkIds.length > 0 ||
      (claim.evidence ?? []).some((item) => Boolean(item.chunkId));
    if (!hasChunk) {
      throw new Error("WIKI_KNOWLEDGE_NO_EVIDENCE");
    }
    const bad = claim.citationSectionIndexes.filter(
      (n) => n < 1 || n > sections.length || !sections[n - 1],
    );
    if (bad.length > 0) {
      throw new Error(`WIKI_SYNTHESIS_BAD_CITATION:${bad.join(",")}`);
    }
  }
}

export function preparePublishedWikiPage(input: {
  page: CompiledWikiPage;
  compiled: CompiledWikiKnowledge;
  compiler: string;
}): CompiledWikiPage {
  const fallbackDocumentId =
    input.page.kind === "document_mirror" ? input.page.sourceDocumentId : "";
  let knowledge = bindKnowledgeEvidence(
    input.compiled.knowledge,
    input.page.sections,
    fallbackDocumentId,
  );
  if (!input.page.userEdited && input.page.knowledge?.claims?.length) {
    knowledge = {
      ...knowledge,
      claims: diffWikiClaims(input.page.knowledge.claims, knowledge.claims),
    };
  }
  const compiled = { ...input.compiled, knowledge };
  assertPublishableKnowledge(compiled, input.page.sections);
  return {
    ...input.page,
    status: "ready",
    userEdited: false,
    synthesisMarkdown: compiled.articleMarkdown,
    synthesisCompiler: input.compiler,
    knowledge: {
      ...knowledge,
      claims: knowledge.claims.map((claim) => ({
        ...claim,
        compilerVersion: claim.compilerVersion || input.compiler,
      })),
    },
  };
}
