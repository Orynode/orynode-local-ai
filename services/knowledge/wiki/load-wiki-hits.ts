/**
 * Wiki 是编译层召回通道，不是第二套 RAG。
 * 事实问答：按节打分后与 L0 做加权 RRF；概述类才由 Engine 短路整页。
 */

import type { RetrievalHit, RetrievalScope } from "../types";
import type { KnowledgeAccessContext } from "../application/scope-policy";
import { defaultScopePolicy } from "../application/scope-policy";
import type { CompiledWikiPage } from "./compile-document-mirror";
import {
  fetchWikiLinks,
  fetchWikiPage,
  fetchWikiPageById,
  listWikiPages,
  searchWikiPages,
} from "./persist";
import { stripSettleMarkers } from "./settle-markers";
import { canReadWikiPage } from "./wiki-access";
import {
  followWikiPages,
  type WikiLink,
  WIKI_FOLLOW_MAX_HOPS,
  WIKI_FOLLOW_MAX_PAGES,
} from "./wiki-graph";
import {
  extractSearchTerms,
  keywordScore,
  weightedRrfFusion,
} from "../retrieval/keyword";
import { contentTermsForLexicalMatch } from "../query/latin-stopwords";
import {
  minimumShouldMatchForTermCount,
  passesCoverage,
} from "../query/lexical-coverage";

export function wikiSynthesisHitId(pageId: string): string {
  return `${pageId}::synthesis`;
}

export function wikiNotesHitId(pageId: string): string {
  return `${pageId}::notes`;
}

export function wikiClaimHitId(pageId: string, claimId: string): string {
  return `${pageId}::${claimId}`;
}

export function hitsFromCompiledPage(
  page: CompiledWikiPage,
  source: RetrievalHit["source"],
): RetrievalHit[] {
  const documentIdFor = (section: CompiledWikiPage["sections"][number]) => {
    const fromSection = String(section.sourceDocumentId || "").trim();
    if (fromSection && !fromSection.startsWith("concept:")) return fromSection;
    const root = String(page.sourceDocumentId || "").trim();
    if (root && !root.startsWith("concept:") && page.kind === "document_mirror") {
      return root;
    }
    return "";
  };
  const extras: RetrievalHit[] = [];
  const synthesis = page.synthesisMarkdown?.trim();
  const notes = stripSettleMarkers(page.notesMarkdown?.trim() || "");
  const first = page.sections[0];
  const documentId =
    (first ? documentIdFor(first) : "") ||
    (page.kind === "document_mirror" ? page.sourceDocumentId : "");
  const sourceChunkId = first?.chunkId?.trim();
  for (const claim of page.status === "stale"
    ? []
    : (page.knowledge?.claims ?? [])) {
    if (claim.status && claim.status !== "active") continue;
    const sectionIndex = claim.citationSectionIndexes[0];
    const section = sectionIndex ? page.sections[sectionIndex - 1] : undefined;
    const claimDocumentId = section ? documentIdFor(section) : documentId;
    if (!claimDocumentId) continue;
    extras.push({
      id: wikiClaimHitId(page.id, claim.id),
      documentId: claimDocumentId,
      documentName: section?.sourceDocumentTitle || page.title,
      pageNumber: section?.pageNumber ?? first?.pageNumber ?? 1,
      position: extras.length,
      content: `${claim.text} ${claim.citationSectionIndexes
        .map((n) => `[S${n}]`)
        .join("")}`,
      score: Math.max(3, page.sections.length + 2),
      source,
      headingPath: ["知识主张"],
      startLine: section?.startLine,
      endLine: section?.endLine,
      ...(claim.sourceChunkIds[0]
        ? { sourceChunkId: claim.sourceChunkIds[0] }
        : {}),
    });
  }
  if (synthesis && page.status !== "stale" && documentId) {
    extras.push({
      id: wikiSynthesisHitId(page.id),
      documentId,
      documentName: page.title,
      pageNumber: first?.pageNumber ?? 1,
      position: extras.length,
      content: synthesis,
      score: Math.max(2, page.sections.length + 1),
      source,
      headingPath: ["综述"],
      startLine: first?.startLine,
      endLine: first?.endLine,
      ...(sourceChunkId ? { sourceChunkId } : {}),
    });
  }
  if (notes && documentId) {
    extras.push({
      id: wikiNotesHitId(page.id),
      documentId,
      documentName: page.title,
      pageNumber: first?.pageNumber ?? 1,
      position: extras.length,
      content: notes,
      score: Math.max(1, page.sections.length),
      source,
      headingPath: ["对话沉淀"],
      startLine: first?.startLine,
      endLine: first?.endLine,
      ...(sourceChunkId ? { sourceChunkId } : {}),
    });
  }
  const sectionHits = page.sections.flatMap((section, index) => {
    const sectionDocumentId = documentIdFor(section);
    if (!sectionDocumentId) return [];
    return [
      {
        id: section.chunkId || `${page.id}:${index}`,
        documentId: sectionDocumentId,
        documentName: section.sourceDocumentTitle || page.title,
        pageNumber: section.pageNumber,
        position: extras.length + index,
        content: `## ${section.heading}\n\n${section.excerpt}`,
        score: Math.max(1, page.sections.length - index),
        source,
        headingPath:
          section.headingPath.length > 0 ? section.headingPath : undefined,
        startLine: section.startLine,
        endLine: section.endLine,
      } satisfies RetrievalHit,
    ];
  });
  return [...extras, ...sectionHits];
}

function sourceIds(scope: RetrievalScope): Array<{
  namespace: "library" | "conversation";
  documentId: string;
  source: RetrievalHit["source"];
}> {
  if (scope.mode !== "sources") return [];
  const out: Array<{
    namespace: "library" | "conversation";
    documentId: string;
    source: RetrievalHit["source"];
  }> = [];
  if (scope.library && typeof scope.library === "object") {
    for (const documentId of scope.library.documentIds) {
      out.push({ namespace: "library", documentId, source: "library" });
    }
  }
  for (const documentId of scope.conversationFiles?.fileIds ?? []) {
    out.push({
      namespace: "conversation",
      documentId,
      source: "conversation_file",
    });
  }
  return out;
}

function hitSourceForPage(
  page: CompiledWikiPage,
  scope: RetrievalScope,
): RetrievalHit["source"] {
  if (page.namespace === "conversation") return "conversation_file";
  if (scope.mode === "sources" && scope.library === "all") return "library";
  return "library";
}

export async function loadWikiHitsForScope(
  scope: RetrievalScope,
  topK: number,
): Promise<RetrievalHit[] | null> {
  if (scope.mode !== "sources" || scope.library === "all") return null;
  const ids = sourceIds(scope);
  if (ids.length === 0 || ids.length > 8) return null;

  const hits: RetrievalHit[] = [];
  for (const item of ids) {
    const page = await fetchWikiPage({
      namespace: item.namespace,
      sourceDocumentId: item.documentId,
    });
    if (!page || page.sections.length === 0) continue;
    hits.push(...hitsFromCompiledPage(page, item.source));
  }
  if (hits.length === 0) return null;
  return hits.slice(0, Math.max(topK, 8));
}

const WIKI_SECTIONS_PER_PAGE = 3;

/**
 * Wiki 过滤词 = Planner 的 MATCH 内容词，不是第二套分词。
 * searchTerms 来自 plan 时复用诚实词表，再走同一层清洗。
 */
export function wikiQueryNeedles(
  query: string,
  _synonyms: string[] = [],
  searchTerms?: string[],
): string[] {
  const extracted =
    searchTerms && searchTerms.length > 0
      ? searchTerms
      : extractSearchTerms(query);
  return contentTermsForLexicalMatch(extracted);
}

export function wikiTextMatchesNeedles(text: string, needles: string[]): boolean {
  if (needles.length === 0) return false;
  const minimum =
    needles.length <= 2
      ? needles.length
      : Math.max(2, minimumShouldMatchForTermCount(needles.length));
  return passesCoverage(text, needles, minimum);
}

function pageSearchText(page: CompiledWikiPage): string {
  const sectionText = page.sections
    .map((section) => `${section.heading}\n${section.excerpt}`)
    .join("\n");
  const synthesis = page.status === "stale" ? "" : (page.synthesisMarkdown ?? "");
  return [
    page.title,
    ...(page.knowledge?.aliases ?? []),
    ...(page.knowledge?.claims.map((claim) => claim.text) ?? []),
    ...(page.knowledge?.relations.map((relation) => relation.target) ?? []),
    page.markdown,
    synthesis,
    page.notesMarkdown ?? "",
    sectionText,
  ].join("\n");
}

function isCompiledBudgetHit(hit: RetrievalHit): boolean {
  const heading = hit.headingPath?.[0];
  return heading === "综述" || heading === "对话沉淀";
}

const WIKI_OVERVIEW_PAGE_CAP = 12;

/** 只保留对得上的 Wiki 节，按内容词打分；禁止整页大纲按页序倾倒 */
export function filterWikiHitsForQuery(
  hits: RetrievalHit[],
  query: string,
  synonyms: string[] = [],
  searchTerms?: string[],
): RetrievalHit[] {
  const needles = wikiQueryNeedles(query, synonyms, searchTerms);
  if (needles.length === 0) return [];
  const scored = hits
    .map((hit) => {
      const hay = `${hit.documentName}\n${hit.content}`;
      if (!wikiTextMatchesNeedles(hay, needles)) return null;
      return { hit, score: keywordScore(hay, needles) };
    })
    .filter((row): row is { hit: RetrievalHit; score: number } => row !== null)
    .sort(
      (a, b) =>
        b.score - a.score || a.hit.position - b.hit.position,
    );
  const perPage = new Map<string, number>();
  const kept: RetrievalHit[] = [];
  for (const row of scored) {
    const count = perPage.get(row.hit.documentId) ?? 0;
    if (count >= WIKI_SECTIONS_PER_PAGE) continue;
    perPage.set(row.hit.documentId, count + 1);
    kept.push({ ...row.hit, score: row.score });
  }
  return kept;
}

async function collectReadableWikiPages(input: {
  query: string;
  scope: Extract<RetrievalScope, { mode: "sources" }>;
  namespaces: Array<"library" | "conversation">;
  access: KnowledgeAccessContext;
  synonyms: string[];
  needles: string[];
  searchTerms?: string[];
  listWhenEmpty: boolean;
}): Promise<CompiledWikiPage[]> {
  const { scope, namespaces, access, needles } = input;
  const foundPages: CompiledWikiPage[] = [];
  const seenPage = new Set<string>();

  async function take(page: CompiledWikiPage): Promise<void> {
    if (seenPage.has(page.id)) return;
    if (!(await canReadWikiPage(page, scope, defaultScopePolicy, access))) {
      return;
    }
    if (needles.length > 0 && !wikiTextMatchesNeedles(pageSearchText(page), needles)) {
      return;
    }
    seenPage.add(page.id);
    foundPages.push(page);
  }

  if (input.listWhenEmpty && needles.length === 0) {
    for (const namespace of namespaces) {
      const found = await listWikiPages({
        namespace,
        limit: WIKI_OVERVIEW_PAGE_CAP,
        conversationId:
          namespace === "conversation"
            ? scope.conversationFiles?.conversationId
            : undefined,
      });
      for (const page of found) {
        await take(page);
      }
    }
    return foundPages;
  }

  const searchQueries = [input.query, ...input.synonyms.slice(0, 3)].filter(
    (item, index, all) => item && all.indexOf(item) === index,
  );
  for (const searchQuery of searchQueries) {
    for (const namespace of namespaces) {
      const found = await searchWikiPages({
        query: searchQuery,
        namespace,
        limit: 8,
        conversationId:
          namespace === "conversation"
            ? scope.conversationFiles?.conversationId
            : undefined,
      });
      for (const page of found) {
        await take(page);
      }
    }
  }
  return foundPages;
}

export async function loadWikiHitsForQuery(
  query: string,
  scope: RetrievalScope,
  topK: number,
  access: KnowledgeAccessContext,
  options?: {
    synonyms?: string[];
    searchTerms?: string[];
    mode?: "query" | "overview";
  },
): Promise<{ hits: RetrievalHit[]; followed: boolean } | null> {
  if (scope.mode !== "sources") return null;
  const namespaces: Array<"library" | "conversation"> = [];
  if (scope.library) namespaces.push("library");
  if (scope.conversationFiles) namespaces.push("conversation");
  if (namespaces.length === 0) return null;

  const synonyms = options?.synonyms ?? [];
  const searchTerms = options?.searchTerms;
  const needles = wikiQueryNeedles(query, synonyms, searchTerms);
  const overview = options?.mode === "overview";

  const pages = await collectReadableWikiPages({
    query,
    scope,
    namespaces,
    access,
    synonyms,
    needles,
    searchTerms,
    listWhenEmpty: overview,
  });
  if (overview) {
    const budgetHits: RetrievalHit[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
      for (const hit of hitsFromCompiledPage(page, hitSourceForPage(page, scope))) {
        if (!isCompiledBudgetHit(hit) || seen.has(hit.id)) continue;
        seen.add(hit.id);
        budgetHits.push(hit);
      }
    }
    const kept =
      needles.length === 0
        ? budgetHits
        : budgetHits.filter((hit) =>
            wikiTextMatchesNeedles(
              `${hit.documentName}\n${hit.content}`,
              needles,
            ),
          );
    if (kept.length === 0) return null;
    return {
      hits: kept.slice(0, Math.max(topK, 8)),
      followed: false,
    };
  }

  if (pages.length === 0) return null;

  const seeds = pages;

  const linkBag: WikiLink[] = [];
  for (const page of seeds.slice(0, 4)) {
    const listed = await fetchWikiLinks(page.id);
    linkBag.push(...listed.outgoing, ...listed.incoming);
  }
  const followedIds = followWikiPages(seeds[0]!.id, linkBag, {
    maxHops: WIKI_FOLLOW_MAX_HOPS,
    maxPages: Math.min(WIKI_FOLLOW_MAX_PAGES, Math.max(topK, 4)),
  });
  const extraPages: CompiledWikiPage[] = [];
  for (const pageId of followedIds) {
    if (seeds.some((page) => page.id === pageId)) continue;
    const page = await fetchWikiPageById(pageId);
    if (!page) continue;
    if (!(await canReadWikiPage(page, scope, defaultScopePolicy, access))) {
      continue;
    }
    if (needles.length > 0 && !wikiTextMatchesNeedles(pageSearchText(page), needles)) {
      continue;
    }
    extraPages.push(page);
  }

  const rawHits: RetrievalHit[] = [];
  const seen = new Set<string>();
  for (const page of [...seeds, ...extraPages]) {
    for (const hit of hitsFromCompiledPage(page, hitSourceForPage(page, scope))) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      rawHits.push(hit);
    }
  }
  const hits = filterWikiHitsForQuery(rawHits, query, synonyms, searchTerms);
  if (hits.length === 0) return null;
  return {
    hits: hits.slice(0, Math.max(topK, 8)),
    followed: extraPages.length > 0,
  };
}

/**
 * Wiki 与 L0 是两路召回，用加权 RRF 融合（Glean / ES hybrid 同型）。
 * 同 id 保留原文切片。wikiWeight < ragWeight：事实问答以 L0 为主。
 */
export function mergeWikiRagHits(
  wikiHits: RetrievalHit[],
  ragHits: RetrievalHit[],
  topK: number,
  options?: { wikiWeight?: number; ragWeight?: number },
): RetrievalHit[] {
  const limit = Math.max(1, topK);
  if (wikiHits.length === 0) return ragHits.slice(0, limit);
  if (ragHits.length === 0) return wikiHits.slice(0, limit);
  const wikiWeight = options?.wikiWeight ?? 0.5;
  const ragWeight = options?.ragWeight ?? 1;
  const fused = weightedRrfFusion(
    [wikiHits.map((hit) => hit.id), ragHits.map((hit) => hit.id)],
    [wikiWeight, ragWeight],
  );
  const byId = new Map<string, RetrievalHit>();
  for (const hit of wikiHits) byId.set(hit.id, hit);
  for (const hit of ragHits) byId.set(hit.id, hit);
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => {
      const hit = byId.get(id)!;
      return { ...hit, score };
    });
}
