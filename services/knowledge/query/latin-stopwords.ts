/**
 * MATCH 内容词清洗（query 层）：拉丁功能词 + 中文低信息/助词。
 * 不进入 retrieval/extractSearchTerms——词抽取保持诚实，低信息只降权不硬删。
 */

import {
  hanTermHasFunctionChar,
  isZhLowInfoMatchTerm,
  peelZhFunctionAffixes,
} from "./zh-function-words";

const LATIN_STOPWORDS = new Set([
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
  "have",
  "has",
  "had",
  "the",
  "an",
  "this",
  "that",
  "these",
  "those",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "by",
  "from",
  "about",
  "into",
  "over",
  "under",
  "and",
  "or",
  "but",
  "so",
  "yet",
  "it",
  "its",
  "they",
  "them",
  "their",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "his",
  "her",
  "as",
  "if",
  "then",
  "than",
  "not",
]);

/** term 是否拉丁功能词 */
export function isLatinStopword(term: string): boolean {
  return LATIN_STOPWORDS.has(String(term ?? "").toLocaleLowerCase());
}

/** 查询中是否含拉丁功能词（自然语言问句信号，非短实体/技术表达式） */
export function containsLatinStopword(query: string): boolean {
  const words =
    String(query ?? "").match(/[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu) ?? [];
  return words.some((word) => isLatinStopword(word));
}

function isHanOnlyTerm(term: string): boolean {
  return /^[\p{Script=Han}]+$/u.test(term);
}

/**
 * general 阶梯用内容词：去掉拉丁功能词与中文问句/低信息形态，避免 AND 被「什么」稀释或误命中。
 * 整句皆拉丁功能词时回退原词表防空转；中文问句剥空则保持空，禁止退回 OR。
 * 短实体 / 引号 / technical 等 strict 类不得调用此清洗。
 */
export function contentTermsForLexicalMatch(terms: string[]): string[] {
  const raw = Array.isArray(terms)
    ? terms.map((t) => String(t ?? "").trim()).filter(Boolean)
    : [];
  if (raw.length === 0) return [];
  const content: string[] = [];
  const seen = new Set<string>();
  for (const term of raw) {
    if (isLatinStopword(term) || isZhLowInfoMatchTerm(term)) continue;
    if (isHanOnlyTerm(term) && term.length === 2 && hanTermHasFunctionChar(term)) {
      continue;
    }
    const next = isHanOnlyTerm(term) ? peelZhFunctionAffixes(term) : term;
    if (!next || next.length < 2) continue;
    if (isLatinStopword(next) || isZhLowInfoMatchTerm(next)) continue;
    const key = next.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    content.push(next);
  }
  if (content.length > 0) return content;
  if (raw.every((term) => isLatinStopword(term))) return raw;
  return [];
}
