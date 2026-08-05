/**
 * QueryPlanner — 唯一决定查询改写、候选规模与召回路径的组件（ML-003）
 *
 * 词法语义对齐 QS-002：phrase → all → minimum_should_match → semantic；
 * 禁止下游自行「AND 空后无条件 OR」。
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
import {
  buildLexicalLadder,
  classifyQuery,
  isQuotedPhrase,
  isZhShortCompound,
  type LexicalLadderStep,
  type QueryClass,
} from "./lexical-coverage";
import type { StructuredQueryRewrite } from "./query-rewrite";
import { EMPTY_REWRITE } from "./terminology-match";

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
  /** 同义短语各自的 phrase 意图（完整边界） */
  phrase?: string;
  queryClass?: QueryClass;
  lexicalLadder?: LexicalLadderStep[];
}

export type { LexicalLadderStep, QueryClass };

export interface RetrievalQueryPlan {
  language: LanguageProfile;
  queryClass: QueryClass;
  /** 有序词法阶梯；Index 只解释阶梯，不得自行全词 OR */
  lexicalLadder: LexicalLadderStep[];
  /** 结构化改写（仅消费注入结果；开放世界由 resolveQueryRewrite 产出） */
  rewrite: StructuredQueryRewrite;
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
  /** 注入改写结果（Engine 经 resolveQueryRewrite 注入；缺省为空） */
  rewrite?: StructuredQueryRewrite;
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

  // 只消费注入的 rewrite；禁止在 Planner 内再查术语表 / 调 LLM
  const rewrite = options.rewrite ?? { ...EMPTY_REWRITE };

  if (trimmed && shouldExpandQuery(trimmed) && rewrite.synonyms.length > 0) {
    rewrite.synonyms.forEach((syn, index) => {
      const synLang = analyzeLanguage(syn);
      const synPhrase = inferPhraseIntent(syn, synLang) ?? syn;
      // 同义短语保持完整边界，禁止再 extractSearchTerms 拆开
      const synTerms = [syn];
      const synClass = classifyQuery({
        query: syn,
        phrase: synPhrase,
        searchTerms: synTerms,
        hasLatin: synLang.hasLatin,
        hasHan: synLang.hasHan,
      });
      variants.push({
        id: `term_expansion_${index + 1}`,
        text: syn,
        kind: "term_expansion",
        language: synLang.primary,
        weight: VARIANT_WEIGHT.term_expansion,
        terms: synTerms,
        phrase: synPhrase,
        queryClass: synClass,
        lexicalLadder: buildLexicalLadder({
          queryClass: synClass,
          phrase: synPhrase,
          terms: synTerms,
        }),
      });
    });
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
  const queryClass = classifyQuery({
    query: trimmed,
    phrase,
    searchTerms,
    exactTermsCount: exactTerms.length,
    hasLatin: language.hasLatin,
    hasHan: language.hasHan,
  });
  const lexicalLadder = buildLexicalLadder({
    queryClass,
    phrase,
    terms: searchTerms,
  });

  const strategies: RetrievalQueryPlan["strategies"] = ["keyword"];
  if (exactTerms.length > 0) strategies.unshift("exact");
  if (options.embedding) strategies.push("vector");
  if (options.rerank) strategies.push("rerank");

  return {
    language,
    queryClass,
    lexicalLadder,
    rewrite,
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
 * 引号短语始终保留。
 * 未加引号：2–6 拉丁词 → 短实体 phrase；单一汉字串 2–6 → 中文短复合 phrase。
 * 长自然语言 / 多段汉字不进 short phrase。
 */
export function inferPhraseIntent(
  query: string,
  language: LanguageProfile,
): string | undefined {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  if (isQuotedPhrase(trimmed)) {
    const quoted = trimmed.match(/^["'「](.+)["'」]$/);
    return quoted?.[1]?.trim() || undefined;
  }
  if (trimmed.length > 80) return undefined;

  if (isZhShortCompound(trimmed)) {
    return trimmed;
  }

  if (!language.hasLatin || language.hasHan) {
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
