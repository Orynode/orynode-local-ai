/**
 * W1 概念页：从各 document_mirror 的标题 + 术语归并，不调用 LLM。
 */

import {
  type CompiledWikiPage,
  type WikiKnowledge,
  type WikiSection,
} from "./compile-document-mirror";
import type { WikiLink } from "./wiki-graph";
import type { TerminologyEntry } from "../query/terminology";
import {
  applyConceptDecisions,
  conceptIdentityFor,
  conceptSlugKey,
  resolveCanonicalLabel,
  type ConceptCluster,
  type WikiDecision,
} from "./wiki-identity";

export { conceptSlugKey } from "./wiki-identity";

export const WIKI_CONCEPT_COMPILER_ID = "concept_cluster_v1";
export const WIKI_MAX_CONCEPT_PAGES = 80;
export const WIKI_MAX_CONCEPT_SECTIONS = 12;

const GENERIC_HEADING = [
  /^第\s*\d+\s*页$/,
  /^(?:sheet:\s*)?sheet\s*\d+$/i,
  /^(?:sheet:\s*)?工作表\s*\d+$/i,
  /^slide\s+\d+$/i,
  /^幻灯片\s*\d+$/,
];

export function lastHeadingSegment(
  heading: string,
  headingPath: string[] = [],
): string {
  const fromPath = headingPath.at(-1)?.trim();
  if (fromPath) return fromPath;
  const parts = heading.split(/\s*\/\s*/).map((part) => part.trim());
  return parts.at(-1) || heading.trim();
}

export function isGenericHeading(heading: string): boolean {
  const text = heading.trim();
  if (text.length < 2) return true;
  return GENERIC_HEADING.some((pattern) => pattern.test(text));
}

export function conceptPageSlug(slugKey: string): string {
  return `concept:library:${slugKey}`;
}

export function conceptSourceId(slugKey: string): string {
  return `concept:${slugKey}`;
}

function pushSection(
  groups: Map<string, ConceptCluster>,
  title: string,
  section: WikiSection,
  documentId: string,
) {
  const key = conceptSlugKey(title);
  if (!key || isGenericHeading(title)) return;
  const existing = groups.get(key);
  if (existing) {
    existing.sections.push(section);
    existing.documentIds.add(documentId);
    return;
  }
  groups.set(key, {
    key,
    title: title.trim(),
    sections: [section],
    documentIds: new Set([documentId]),
  });
}

function clipExcerpt(excerpt: string, maxChars = 280): string {
  const text = excerpt.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

function termHitsSection(term: string, section: WikiSection): boolean {
  const needle = term.trim().toLocaleLowerCase();
  if (needle.length < 2) return false;
  const hay = `${section.heading}\n${section.excerpt}`.toLocaleLowerCase();
  return hay.includes(needle);
}

export function compileConceptPages(input: {
  mirrors: CompiledWikiPage[];
  terms?: string[];
  terminologyEntries?: TerminologyEntry[];
  decisions?: WikiDecision[];
}): { pages: CompiledWikiPage[]; links: WikiLink[] } {
  const groups = new Map<string, ConceptCluster>();
  const canonicalTerms = (input.terminologyEntries ?? []).flatMap((entry) => {
    const aliases = entry.terms.map((term) => String(term).trim()).filter(Boolean);
    const title = aliases[0];
    if (!title) return [];
    return aliases.map((term) => ({ term, title }));
  });
  const looseTerms = (input.terms ?? []).map((term) => ({ term, title: term }));
  const terms = [...canonicalTerms, ...looseTerms];
  const mirrors = input.mirrors.filter(
    (page) =>
      page.kind === "document_mirror" &&
      page.namespace === "library" &&
      page.sections.length > 0,
  );

  const terminologyEntries = input.terminologyEntries ?? [];
  for (const mirror of mirrors) {
    for (const section of mirror.sections) {
      const tagged: WikiSection = {
        ...section,
        sourceDocumentId: mirror.sourceDocumentId,
        sourceDocumentTitle: mirror.title,
      };
      const path =
        Array.isArray(section.headingPath) && section.headingPath.length > 0
          ? section.headingPath
          : [lastHeadingSegment(section.heading, section.headingPath)];
      const titles = new Set<string>();
      for (const part of path) {
        const title = part.trim();
        if (title) titles.add(title);
      }
      for (const title of titles) {
        pushSection(
          groups,
          resolveCanonicalLabel(title, terminologyEntries),
          tagged,
          mirror.sourceDocumentId,
        );
      }
      for (const { term, title } of terms) {
        if (isGenericHeading(term)) continue;
        if (!termHitsSection(term, section)) continue;
        pushSection(groups, title, tagged, mirror.sourceDocumentId);
      }
    }
  }

  const clustered = applyConceptDecisions(groups, input.decisions);
  const ranked = [...clustered.values()]
    .filter((group) => {
      if (group.identity?.pinned) return group.sections.length > 0;
      if (group.documentIds.size >= 2) return true;
      if (group.sections.length >= 2) return true;
      return terms.some(
        ({ title }) => conceptSlugKey(title) === group.key,
      );
    })
    .sort((a, b) => {
      const docs = b.documentIds.size - a.documentIds.size;
      if (docs !== 0) return docs;
      return b.sections.length - a.sections.length;
    })
    .slice(0, WIKI_MAX_CONCEPT_PAGES);

  const pages: CompiledWikiPage[] = [];
  const links: WikiLink[] = [];
  const seenLink = new Set<string>();

  function addLink(fromId: string, toId: string, rel: WikiLink["rel"]) {
    const key = `${fromId}|${toId}|${rel}`;
    if (seenLink.has(key) || fromId === toId) return;
    seenLink.add(key);
    links.push({ fromId, toId, rel });
  }

  for (const group of ranked) {
    const identity =
      group.identity ||
      conceptIdentityFor(group.title, terminologyEntries);
    const slug = conceptPageSlug(group.key);
    const uniqueDocs = [...group.documentIds];
    const sections = group.sections.slice(0, WIKI_MAX_CONCEPT_SECTIONS);
    const body = sections
      .map((section) => {
        const source = section.sourceDocumentTitle || section.sourceDocumentId;
        return `## ${section.heading}\n\n来自《${source}》\n\n${clipExcerpt(section.excerpt)}`;
      })
      .join("\n\n");
    const aliases = [
      ...new Set([
        ...identity.aliases,
        ...terms
          .filter(({ title }) => conceptSlugKey(title) === conceptSlugKey(identity.canonicalTitle))
          .map(({ term }) => term)
          .filter((term) => conceptSlugKey(term) !== conceptSlugKey(identity.canonicalTitle)),
      ]),
    ];
    pages.push({
      id: slug,
      slug,
      title: group.title,
      kind: "concept",
      namespace: "library",
      sourceDocumentId: conceptSourceId(group.key),
      markdown: [
        `# ${group.title}`,
        "",
        `这个概念页从 ${uniqueDocs.length} 篇资料的标题归并，没有调用大模型。每一节都能回到原来的切片。`,
        "",
        body || "（没有可归并的章节）",
      ].join("\n"),
      sections,
      compiler: WIKI_CONCEPT_COMPILER_ID,
      status: "ready",
      identity,
      knowledge: {
        aliases,
        claims: [],
        relations: [],
        identity,
      },
    });

    const mirrorIds = new Set<string>();
    if (uniqueDocs.length >= 2) {
      for (const section of sections) {
        const documentId = section.sourceDocumentId;
        if (!documentId) continue;
        const mirror = mirrors.find((page) => page.sourceDocumentId === documentId);
        if (!mirror) continue;
        mirrorIds.add(mirror.id);
        addLink(slug, mirror.id, "cites");
        addLink(mirror.id, slug, "part_of");
      }
      const mirrorList = [...mirrorIds].slice(0, 6);
      for (let i = 0; i < mirrorList.length; i += 1) {
        for (let j = i + 1; j < mirrorList.length; j += 1) {
          addLink(mirrorList[i]!, mirrorList[j]!, "see_also");
          addLink(mirrorList[j]!, mirrorList[i]!, "see_also");
        }
      }
    }
  }

  return { pages, links };
}

/**
 * 归并只更新大纲 / 别名 / 身份。已发布的 claims、relations、综述保留；
 * 过时页不得被写回 ready。
 */
export function mergeConceptPageForUpsert(
  compiled: CompiledWikiPage,
  existing?: CompiledWikiPage | null,
): CompiledWikiPage {
  if (!existing) return compiled;
  const aliases = [
    ...new Set([
      ...(compiled.knowledge?.aliases ?? []),
      ...(compiled.identity?.aliases ?? []),
      ...(existing.knowledge?.aliases ?? []),
      ...(existing.identity?.aliases ?? []),
    ]),
  ];
  const knowledge: WikiKnowledge = {
    aliases,
    claims: existing.knowledge?.claims ?? [],
    relations: existing.knowledge?.relations ?? [],
    identity:
      compiled.identity ??
      compiled.knowledge?.identity ??
      existing.knowledge?.identity,
  };
  return {
    ...compiled,
    identity: compiled.identity ?? existing.identity,
    knowledge,
    status: existing.status === "stale" ? "stale" : compiled.status,
    synthesisMarkdown: existing.synthesisMarkdown?.trim()
      ? existing.synthesisMarkdown
      : compiled.synthesisMarkdown,
    synthesisCompiler: existing.synthesisCompiler || compiled.synthesisCompiler,
    notesMarkdown: existing.notesMarkdown?.trim()
      ? existing.notesMarkdown
      : compiled.notesMarkdown,
  };
}
