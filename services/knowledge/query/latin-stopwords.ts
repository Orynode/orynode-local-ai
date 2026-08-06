/**
 * 拉丁功能词：仅作查询形态信号与 general 阶梯匹配词清洗（query 层）。
 * 不进入 retrieval/extractSearchTerms——词抽取保持诚实，与中文「低信息只降权不硬删」对称。
 */

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

/**
 * general 阶梯用内容词：去掉功能词，避免 AND / minimum_match 被稀释。
 * 若过滤后为空（整句皆功能词），回退原词表防空转。
 * 短实体 / 引号 / technical 等 strict 类不得调用此清洗。
 */
export function contentTermsForLexicalMatch(terms: string[]): string[] {
  const raw = Array.isArray(terms)
    ? terms.map((t) => String(t ?? "").trim()).filter(Boolean)
    : [];
  if (raw.length === 0) return [];
  const content = raw.filter((t) => !isLatinStopword(t));
  return content.length > 0 ? content : raw;
}
