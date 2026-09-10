/**
 * compile_wiki_concepts Job：用户点击后从大纲归并概念页。
 * 抽取即可，不占用 Gemma。
 */

import { randomUUID } from "node:crypto";
import { BUILTIN_TERMINOLOGY } from "../query/terminology";
import { listLearnedTerminology } from "../query/terminology-client";
import {
  compileConceptPages,
  mergeConceptPageForUpsert,
  WIKI_CONCEPT_COMPILER_ID,
} from "./compile-concepts";
import {
  compileDocumentMirror,
  WIKI_LIBRARY_SCAN_CAP,
  type CompiledWikiPage,
  type WikiCompileChunk,
} from "./compile-document-mirror";
import {
  deleteWikiPage,
  fetchWikiLinks,
  listAllWikiPendingEdges,
  listWikiDecisions,
  listWikiPages,
  recordWikiBuild,
  replaceWikiLinks,
  replaceWikiPendingEdges,
  upsertWikiPage,
} from "./persist";
import { promotePendingWikiEdges } from "./wiki-relations";
import { mergeClusteringOutgoing, type WikiLink } from "./wiki-graph";

export type CompileConceptsJobResult = {
  deferred?: false;
  buildId: string;
  pageCount: number;
  linkCount: number;
  compiler: string;
};

type LibraryDoc = { id: string; name?: string };

export async function runCompileConceptsJob(context: {
  payload?: Record<string, unknown>;
  jobId?: string;
  onProgress?: (progress: Record<string, unknown>) => void;
  fetchLibraryDocuments?: () => Promise<LibraryDoc[]>;
  fetchChunks?: (input: {
    namespace: "library" | "conversation";
    documentId: string;
  }) => Promise<WikiCompileChunk[]>;
}): Promise<CompileConceptsJobResult> {
  const report = (progress: Record<string, unknown>) => {
    context.onProgress?.({ namespace: "library", ...progress });
  };

  report({ phase: "clustering" });
  const mirrors = await collectLibraryMirrors({
    fetchLibraryDocuments: context.fetchLibraryDocuments,
    fetchChunks: context.fetchChunks,
  });
  const terminologyEntries = await loadConceptTerminology();
  const decisions = await listWikiDecisions();
  const compiled = compileConceptPages({
    mirrors,
    terminologyEntries,
    decisions,
  });

  const existingConcepts = await listWikiPages({
    namespace: "library",
    kind: "concept",
    limit: WIKI_LIBRARY_SCAN_CAP,
  });
  const nextIds = new Set(compiled.pages.map((page) => page.id));
  for (const page of existingConcepts) {
    if (page.userEdited) continue;
    if (nextIds.has(page.id)) continue;
    await deleteWikiPage(page.id);
  }

  report({ phase: "writing", done: 0, total: compiled.pages.length });
  const buildId = randomUUID();
  const keptIds = new Set<string>();
  let written = 0;
  for (const page of compiled.pages) {
    const existing = existingConcepts.find((item) => item.id === page.id);
    if (existing?.userEdited) {
      keptIds.add(existing.id);
      continue;
    }
    const stored = await upsertWikiPage({
      ...mergeConceptPageForUpsert(page, existing),
      wikiBuildId: buildId,
    });
    keptIds.add(stored?.id ?? page.id);
    written += 1;
    report({
      phase: "writing",
      done: written,
      total: compiled.pages.length,
    });
  }

  const knownIds = new Set([
    ...keptIds,
    ...mirrors.map((page) => page.id),
  ]);
  const linksByFrom = new Map<string, WikiLink[]>();
  for (const link of compiled.links) {
    if (!knownIds.has(link.fromId) || !knownIds.has(link.toId)) continue;
    const list = linksByFrom.get(link.fromId) ?? [];
    list.push(link);
    linksByFrom.set(link.fromId, list);
  }
  let linkCount = 0;
  for (const [fromId, links] of linksByFrom) {
    const existingLinks = await fetchWikiLinks(fromId);
    const merged = mergeClusteringOutgoing(existingLinks.outgoing, links);
    const writtenLinks = await replaceWikiLinks(fromId, merged);
    linkCount += writtenLinks.length;
  }

  linkCount += await promoteResolvedPendingEdges([
    ...compiled.pages.map((page) => ({
      id: page.id,
      title: page.title,
      aliases: [
        ...(page.knowledge?.aliases ?? []),
        ...(page.identity?.aliases ?? []),
      ],
    })),
    ...existingConcepts
      .filter((page) => page.userEdited)
      .map((page) => ({
        id: page.id,
        title: page.title,
        aliases: [
          ...(page.knowledge?.aliases ?? []),
          ...(page.identity?.aliases ?? []),
        ],
      })),
  ]);

  await recordWikiBuild({
    id: buildId,
    namespace: "library",
    compiler: WIKI_CONCEPT_COMPILER_ID,
    pageCount: keptIds.size,
    linkCount,
  });
  report({ phase: "ready", pageCount: keptIds.size, linkCount });
  return {
    buildId,
    pageCount: keptIds.size,
    linkCount,
    compiler: WIKI_CONCEPT_COMPILER_ID,
  };
}

async function collectLibraryMirrors(input: {
  fetchLibraryDocuments?: () => Promise<LibraryDoc[]>;
  fetchChunks?: (input: {
    namespace: "library" | "conversation";
    documentId: string;
  }) => Promise<WikiCompileChunk[]>;
}): Promise<CompiledWikiPage[]> {
  const listed = await listWikiPages({
    namespace: "library",
    kind: "document_mirror",
    limit: WIKI_LIBRARY_SCAN_CAP,
  });
  const bySource = new Map(
    listed.map((page) => [page.sourceDocumentId, page] as const),
  );
  const docs = ((await input.fetchLibraryDocuments?.()) ?? []).slice(
    0,
    WIKI_LIBRARY_SCAN_CAP,
  );
  const mirrors: CompiledWikiPage[] = [...listed];
  for (const doc of docs) {
    if (bySource.has(doc.id)) continue;
    if (!input.fetchChunks) continue;
    const chunks = await input.fetchChunks({
      namespace: "library",
      documentId: doc.id,
    });
    if (!chunks.length) continue;
    const page = compileDocumentMirror({
      namespace: "library",
      documentId: doc.id,
      title: String(doc.name || doc.id),
      chunks,
    });
    const stored = await upsertWikiPage(page);
    bySource.set(doc.id, stored);
    mirrors.push(stored);
  }
  if (mirrors.length === 0 && listed.length > 0) return listed;
  return mirrors.filter((page) => page.kind === "document_mirror");
}

async function loadConceptTerminology() {
  const learned = await listLearnedTerminology();
  return [...learned, ...BUILTIN_TERMINOLOGY];
}

async function promoteResolvedPendingEdges(
  catalog: Array<{ id: string; title: string; aliases: string[] }>,
): Promise<number> {
  const pending = await listAllWikiPendingEdges();
  if (pending.length === 0) return 0;
  const promoted = promotePendingWikiEdges({ pending, catalog });
  let extra = 0;
  for (const item of promoted) {
    if (item.resolved.length === 0) continue;
    const existing = await fetchWikiLinks(item.fromId);
    const seen = new Set(
      existing.outgoing.map((link) => `${link.toId}|${link.rel}`),
    );
    const merged: WikiLink[] = [...existing.outgoing];
    for (const link of item.resolved) {
      const key = `${link.toId}|${link.rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(link);
      extra += 1;
    }
    await replaceWikiLinks(item.fromId, merged);
    await replaceWikiPendingEdges(
      item.fromId,
      item.remaining.map((edge) => ({
        target: edge.target,
        rel: edge.rel,
        citationSectionIndexes: edge.citationSectionIndexes,
      })),
    );
  }
  return extra;
}
