/**
 * 检索结果 UI 高亮词：查询词 + planner 词项 + 简繁展开。
 * 跨语言正文高亮依赖查询里已有的拉丁词，或下文小词典（非完整翻译）。
 */

import { SEARCH_CONFIG } from "../../../config/defaults";
import type { ExactTerm } from "../query/exact-terms";
import type { QueryVariant } from "../query/planner";
import { expandTerminology } from "../query/terminology";

/** 与 indexing/multilingual-normalizer 对齐的高置信简繁对（高亮用） */
const S2T: Record<string, string> = {
  国: "國",
  们: "們",
  过: "過",
  来: "來",
  时: "時",
  么: "麼",
  对: "對",
  东: "東",
  车: "車",
  门: "門",
  开: "開",
  关: "關",
  为: "爲",
  说: "說",
  与: "與",
  学: "學",
  发: "發",
  经: "經",
  总: "總",
  体: "體",
  实: "實",
  际: "際",
  现: "現",
  应: "應",
  会: "會",
  语: "語",
  库: "庫",
  检: "檢",
  索: "索",
  档: "檔",
  标: "標",
  题: "題",
  识: "識",
  资: "資",
  传: "傳",
  数: "數",
  据: "據",
};

const T2S: Record<string, string> = Object.fromEntries(
  Object.entries(S2T).map(([s, t]) => [t, s]),
);

function expandHansHant(term: string): string[] {
  const toT = [...term].map((ch) => S2T[ch] ?? ch).join("");
  const toS = [...term].map((ch) => T2S[ch] ?? ch).join("");
  return [...new Set([term, toT, toS].filter((t) => t && t !== ""))];
}

export type BuildHighlightTermsInput = {
  query: string;
  searchTerms?: string[];
  exactTerms?: ExactTerm[];
  variants?: QueryVariant[];
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

  for (const term of seed) {
    push(term);
    for (const form of expandHansHant(term)) push(form);
    for (const related of expandTerminology(term)) push(related);
    for (const run of term.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
      push(run);
      for (const form of expandHansHant(run)) push(form);
      for (const related of expandTerminology(run)) push(related);
    }
  }

  ordered.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return ordered.slice(0, max);
}
