/**
 * QueryPlanner — 唯一决定查询改写、候选规模与召回路径的组件（ML-003）
 */

import { SEARCH_CONFIG } from "../../../config/defaults";
import { extractSearchTerms } from "../retrieval/keyword";
import { buildMultiQueries } from "../retrieval/multi-query";
import { shouldExpandQuery } from "../retrieval/query-type";
import { extractExactTerms, type ExactTerm } from "./exact-terms";
import {
  analyzeLanguage,
  type LanguageProfile,
  type LanguageTag,
} from "./language-analyzer";
import { expandTerminology } from "./terminology";

export type QueryVariantKind =
  | "original"
  | "normalized"
  | "term_expansion"
  | "translation";

export interface QueryVariant {
  id: string;
  text: string;
  kind: QueryVariantKind;
  language: LanguageTag;
  weight: number;
  /**
   * 结构化召回词项。术语扩展必须保留原始边界，不能在下游把
   * `atomistic atomic-scale` 再切成 `atomic` / `scale` 等宽泛词。
   */
  terms?: string[];
}

export interface RetrievalQueryPlan {
  language: LanguageProfile;
  variants: QueryVariant[];
  /** 用户原始查询中的短语意图；索引层按 phrase → AND 分层执行。 */
  phrase?: string;
  exactTerms: ExactTerm[];
  /** 供 FTS MATCH 的合并词项（含 exact） */
  searchTerms: string[];
  strategies: Array<"exact" | "keyword" | "vector" | "rerank">;
  budgets: {
    exactCandidates: number;
    keywordCandidates: number;
    vectorCandidates: number;
    rerankCandidates: number;
  };
}

export type PlanQueryOptions = {
  multiQuery?: boolean;
  embedding?: boolean;
  rerank?: boolean;
  topK?: number;
};

const VARIANT_WEIGHT: Record<QueryVariantKind, number> = {
  original: 1.2,
  normalized: 1.0,
  term_expansion: 0.8,
  translation: 0.7,
};

/**
 * 只生成计划，不执行检索。
 */
export function planQuery(
  query: string,
  options: PlanQueryOptions = {},
): RetrievalQueryPlan {
  const trimmed = query.replace(/\s+/g, " ").trim();
  const language = analyzeLanguage(trimmed);
  const exactTerms = extractExactTerms(trimmed);
  const phrase = inferPhraseIntent(trimmed, language);
  const topK = Math.max(1, options.topK ?? SEARCH_CONFIG.topK);

  const variants: QueryVariant[] = [];
  if (trimmed) {
    variants.push({
      id: "original",
      text: trimmed,
      kind: "original",
      language: language.primary,
      weight: VARIANT_WEIGHT.original,
    });
  }

  // 高置信术语扩展始终可用于关键词召回，不依赖 embedding/Quality。
  // 精确类查询不扩展，避免改写文件名、错误码和代码符号。
  if (trimmed && shouldExpandQuery(trimmed)) {
    const relatedTerms = expandTerminology(trimmed);
    // 纯中文查询只生成非汉字术语，纯英文查询只生成汉字术语；
    // mixed/undetermined 保留完整关联词，避免猜错目标语言。
    const expandedTerms = language.hasHan && !language.hasLatin
      ? relatedTerms.filter((term) => !/\p{Script=Han}/u.test(term))
      : language.hasLatin && !language.hasHan
        ? relatedTerms.filter((term) => /\p{Script=Han}/u.test(term))
        : relatedTerms;
    if (expandedTerms.length > 0) {
      const text = expandedTerms.join(" ");
      variants.push({
        id: "term_expansion_1",
        text,
        kind: "term_expansion",
        language: analyzeLanguage(text).primary,
        weight: VARIANT_WEIGHT.term_expansion,
        terms: expandedTerms,
      });
    }
  }

  const expand =
    Boolean(options.multiQuery) &&
    trimmed.length > 0 &&
    shouldExpandQuery(trimmed);

  if (expand) {
    const multi = buildMultiQueries(trimmed);
    for (let i = 1; i < multi.length; i += 1) {
      const text = multi[i]!;
      variants.push({
        id: `normalized_${i}`,
        text,
        kind: "normalized",
        language: language.primary,
        weight: VARIANT_WEIGHT.normalized,
      });
    }
  }

  const searchTerms = mergeSearchTerms(trimmed, exactTerms);

  const strategies: RetrievalQueryPlan["strategies"] = ["keyword"];
  if (exactTerms.length > 0) strategies.unshift("exact");
  if (options.embedding) strategies.push("vector");
  if (options.rerank) strategies.push("rerank");

  return {
    language,
    variants: variants.length > 0 ? variants : [],
    phrase,
    exactTerms,
    searchTerms,
    strategies,
    budgets: {
      exactCandidates: Math.min(20, topK * 3),
      keywordCandidates: Math.max(40, topK * 5),
      vectorCandidates: Math.max(40, topK * 5),
      rerankCandidates: Math.min(30, topK * 4),
    },
  };
}

/**
 * 引号短语始终保留；未加引号的 2–6 个拉丁词也视为短语意图。
 * 这覆盖标题、术语和实体名，同时把较长自然语言问题留给普通查询规划。
 */
function inferPhraseIntent(
  query: string,
  language: LanguageProfile,
): string | undefined {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  const quoted = trimmed.match(/^["'「](.+)["'」]$/);
  if (quoted?.[1]) return quoted[1].trim();
  if (!language.hasLatin || language.hasHan || trimmed.length > 80) {
    return undefined;
  }
  const words = trimmed.match(/[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu) ?? [];
  if (words.length < 2 || words.length > 6) return undefined;
  return words.join(" ");
}

function mergeSearchTerms(query: string, exactTerms: ExactTerm[]): string[] {
  const terms = extractSearchTerms(query);
  const seen = new Set(terms.map((t) => t.toLocaleLowerCase()));
  const out = [...terms];
  for (const exact of exactTerms) {
    const key = exact.value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.unshift(exact.value.toLocaleLowerCase());
  }
  return out.slice(0, SEARCH_CONFIG.maxSearchTerms);
}
