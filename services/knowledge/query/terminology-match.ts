/**
 * 术语匹配工具（唯一实现，禁止再复制一份 containsTerm）
 */

import { analyzeLanguage } from "./language-analyzer";
import { isZhShortCompound } from "./lexical-coverage";
import type { TerminologyEntry } from "./terminology";
import type { StructuredQueryRewrite } from "./query-rewrite";

export function containsTerm(text: string, term: string): boolean {
  const normalized = text.toLocaleLowerCase();
  const needle = term.toLocaleLowerCase();
  if (!needle) return false;

  if (/\p{Script=Han}/u.test(needle)) {
    if (!normalized.includes(needle)) return false;
    // 短复合查询禁止更短汉字术语靠子串触发
    if (isZhShortCompound(normalized) && needle.length < normalized.length) {
      return false;
    }
    return true;
  }

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`,
    "iu",
  ).test(normalized);
}

export function filterSynonymsByQueryLanguage(
  terms: string[],
  query: string,
): string[] {
  const language = analyzeLanguage(query);
  if (language.hasHan && !language.hasLatin) {
    return terms.filter((term) => !/\p{Script=Han}/u.test(term));
  }
  if (language.hasLatin && !language.hasHan) {
    return terms.filter((term) => /\p{Script=Han}/u.test(term));
  }
  return terms;
}

/** 从条目目录生成结构化改写（同步；供 resolveQueryRewrite 使用） */
export function rewriteFromEntries(
  query: string,
  entries: readonly TerminologyEntry[],
  source: StructuredQueryRewrite["source"],
  maxSynonyms = 8,
): StructuredQueryRewrite {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return { source: "none", synonyms: [], exclude: [], matchedEntryIds: [] };
  }

  const synonyms: string[] = [];
  const exclude: string[] = [];
  const matchedEntryIds: string[] = [];
  const seenSyn = new Set<string>();
  const seenEx = new Set<string>();
  let domain: string | undefined;

  for (const entry of entries) {
    if (!entry.terms.some((term) => containsTerm(trimmed, term))) continue;
    matchedEntryIds.push(entry.id);
    if (!domain && entry.domain) domain = entry.domain;
    for (const term of entry.terms) {
      if (containsTerm(trimmed, term)) continue;
      const key = term.toLocaleLowerCase();
      if (seenSyn.has(key)) continue;
      seenSyn.add(key);
      synonyms.push(term);
      if (synonyms.length >= maxSynonyms) break;
    }
    for (const term of entry.exclude ?? []) {
      const key = term.toLocaleLowerCase();
      if (seenEx.has(key) || containsTerm(trimmed, term)) continue;
      seenEx.add(key);
      exclude.push(term);
    }
    if (synonyms.length >= maxSynonyms) break;
  }

  return {
    source: matchedEntryIds.length > 0 ? source : "none",
    domain,
    synonyms: filterSynonymsByQueryLanguage(synonyms, trimmed).slice(
      0,
      maxSynonyms,
    ),
    exclude,
    matchedEntryIds,
  };
}

export const EMPTY_REWRITE: StructuredQueryRewrite = {
  source: "none",
  synonyms: [],
  exclude: [],
  matchedEntryIds: [],
};
