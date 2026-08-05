/**
 * 检索结果 UI 高亮词：查询词 + planner 词项 + rewrite 同义 + 简繁展开。
 * 跨语言同义只来自 resolveQueryRewrite（经 plan.rewrite.synonyms），禁止再查内置表。
 * 简繁变体唯一来源：indexing/multilingual-normalizer.hansHantVariants。
 */

import { SEARCH_CONFIG } from "../../../config/defaults";
import { hansHantVariants } from "../indexing/multilingual-normalizer";
import type { ExactTerm } from "../query/exact-terms";
import type { QueryVariant } from "../query/planner";

export type BuildHighlightTermsInput = {
  query: string;
  searchTerms?: string[];
  exactTerms?: ExactTerm[];
  variants?: QueryVariant[];
  /** 来自 plan.rewrite.synonyms */
  synonyms?: string[];
  maxTerms?: number;
};

/**
 * 合并可供 UI `<mark>` 的词项（去重、长词优先）。
 */
export function buildHighlightTerms(
  input: BuildHighlightTermsInput,
): string[] {
  const max = input.maxTerms ?? SEARCH_CONFIG.maxSearchTerms;
  const seen = new Set<string>();
  const ordered: string[] = [];

  const push = (raw: string) => {
    const term = raw.trim();
    if (!term) return;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(term);
  };

  const seed: string[] = [];
  if (input.query.trim()) seed.push(input.query.trim());
  for (const t of input.searchTerms ?? []) seed.push(t);
  for (const t of input.exactTerms ?? []) seed.push(t.value);
  for (const v of input.variants ?? []) seed.push(v.text);
  for (const s of input.synonyms ?? []) seed.push(s);

  for (const term of seed) {
    push(term);
    for (const form of hansHantVariants(term)) push(form);
    for (const run of term.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
      push(run);
      for (const form of hansHantVariants(run)) push(form);
    }
  }

  ordered.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return ordered.slice(0, max);
}
