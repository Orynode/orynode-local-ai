/**
 * 词法覆盖率（与 services/knowledge/query/lexical-coverage.ts + latin-stopwords.ts 对齐）
 *
 * MATCH 清洗：拉丁功能词 + 中文低信息/助词。不在 search-text.extractSearchTerms 硬删。
 */

import { ZH_LOW_INFO_BIGRAMS } from "./search-text.mjs";

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

/**
 * @param {string} term
 */
export function isLatinStopword(term) {
  return LATIN_STOPWORDS.has(String(term ?? "").toLocaleLowerCase());
}

/**
 * @param {string} query
 */
export function containsLatinStopword(query) {
  const words =
    String(query ?? "").match(/[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu) ?? [];
  return words.some((word) => isLatinStopword(word));
}

const ZH_FUNCTION_CHARS = new Set([
  "是",
  "的",
  "了",
  "吗",
  "呢",
  "吧",
  "啊",
  "嘛",
  "着",
  "过",
  "得",
  "地",
  "么",
  "啥",
  "呀",
]);

/**
 * @param {string} run
 * @returns {boolean[]}
 */
function markZhLowInfoChars(run) {
  const skip = Array.from({ length: run.length }, () => false);
  for (let i = 0; i < run.length - 1; i += 1) {
    if (ZH_LOW_INFO_BIGRAMS.has(run.slice(i, i + 2))) {
      skip[i] = true;
      skip[i + 1] = true;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < run.length; i += 1) {
      if (skip[i] || !ZH_FUNCTION_CHARS.has(run[i])) continue;
      const adjacent =
        (i > 0 && skip[i - 1]) || (i + 1 < run.length && skip[i + 1]);
      if (adjacent) {
        skip[i] = true;
        changed = true;
      }
    }
  }
  return skip;
}

/**
 * @param {string} term
 * @returns {string}
 */
export function peelZhFunctionAffixes(term) {
  const raw = String(term ?? "").trim();
  if (!raw) return "";
  if (!/^[\p{Script=Han}]+$/u.test(raw)) return raw;
  const skip = markZhLowInfoChars(raw);
  let best = "";
  let i = 0;
  while (i < raw.length) {
    if (skip[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < raw.length && !skip[j]) j += 1;
    let span = raw.slice(i, j);
    while (span.length > 0 && ZH_FUNCTION_CHARS.has(span[0])) {
      span = span.slice(1);
    }
    while (
      span.length > 0 &&
      ZH_FUNCTION_CHARS.has(span[span.length - 1])
    ) {
      span = span.slice(0, -1);
    }
    if (span.length > best.length) best = span;
    i = j;
  }
  return best.length >= 2 ? best : "";
}

/**
 * @param {string[]} terms
 */
export function contentTermsForLexicalMatch(terms) {
  const raw = Array.isArray(terms)
    ? terms.map((t) => String(t ?? "").trim()).filter(Boolean)
    : [];
  if (raw.length === 0) return [];
  const content = [];
  const seen = new Set();
  for (const term of raw) {
    const hanOnly = /^[\p{Script=Han}]+$/u.test(term);
    if (isLatinStopword(term) || ZH_LOW_INFO_BIGRAMS.has(term)) continue;
    if (
      hanOnly &&
      term.length === 2 &&
      [...term].some((char) => ZH_FUNCTION_CHARS.has(char))
    ) {
      continue;
    }
    const next = hanOnly ? peelZhFunctionAffixes(term) : term;
    if (!next || next.length < 2) continue;
    if (isLatinStopword(next) || ZH_LOW_INFO_BIGRAMS.has(next)) continue;
    const key = next.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    content.push(next);
  }
  if (content.length > 0) return content;
  if (raw.every((term) => isLatinStopword(term))) return raw;
  return [];
}

/**
 * @param {number} termCount
 */
export function minimumShouldMatchForTermCount(termCount) {
  const n = Math.max(0, Math.floor(termCount));
  if (n <= 0) return 0;
  if (n <= 2) return n;
  if (n <= 4) return Math.ceil(n * 0.75);
  if (n <= 8) return Math.ceil(n * 0.6);
  return Math.max(1, Math.ceil(n * 0.5));
}

/**
 * @param {number} bigramCount
 */
export function minimumShouldMatchForZhBigrams(bigramCount) {
  const n = Math.max(0, Math.floor(bigramCount));
  if (n <= 0) return 0;
  if (n <= 3) return n;
  if (n <= 6) return Math.ceil(n * 0.75);
  return Math.ceil(n * 0.6);
}

/**
 * @param {string} term
 */
export function isHanOnlyTerm(term) {
  return /^[\p{Script=Han}]+$/u.test(String(term ?? "").trim());
}

/**
 * @param {string} query
 */
export function isZhShortCompound(query) {
  const trimmed = String(query ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 6) return false;
  return /^[\p{Script=Han}]{2,6}$/u.test(trimmed);
}

/**
 * @param {string} query
 */
export function hasExplicitOr(query) {
  return /\bOR\b/i.test(String(query ?? ""));
}

/**
 * @param {string} query
 */
export function isQuotedPhrase(query) {
  const trimmed = String(query ?? "").replace(/\s+/g, " ").trim();
  return (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 2) ||
    (trimmed.startsWith("「") && trimmed.endsWith("」") && trimmed.length > 2)
  );
}

/**
 * 汉字整段（≥3 字）若其全部 bigram 已在词表中，coverage 不重复计数；
 * 与 termsForAndMatch 的 AND 侧去重对齐，避免 minimum_match 门槛被稀释。
 * @param {string} term
 * @param {Set<string>} termSet
 */
function isHanRunCoveredByBigrams(term, termSet) {
  if (!/^[\p{Script=Han}]{3,}$/u.test(term)) return false;
  for (let i = 0; i < term.length - 1; i += 1) {
    if (!termSet.has(term.slice(i, i + 2))) return false;
  }
  return true;
}

/**
 * @param {string} content
 * @param {string[]} terms
 */
export function countTermCoverage(content, terms) {
  const hay = String(content ?? "").toLocaleLowerCase();
  if (!hay || !Array.isArray(terms) || terms.length === 0) return 0;
  let hit = 0;
  const seen = new Set();
  const lowered = terms
    .map((raw) => String(raw ?? "").toLocaleLowerCase().trim())
    .filter(Boolean);
  const termSet = new Set(lowered);
  for (const term of lowered) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    // QS §5.2 按 bigram 计数：整段汉字已被其 bigram 覆盖时不双重计分
    if (isHanRunCoveredByBigrams(term, termSet)) continue;
    if (hay.includes(term)) hit += 1;
  }
  return hit;
}

/**
 * @param {string} content
 * @param {string[]} terms
 * @param {number} minimum
 */
export function passesCoverage(content, terms, minimum) {
  const min = Math.max(1, Math.floor(minimum));
  return countTermCoverage(content, terms) >= min;
}

/**
 * @param {{ query: string, phrase?: string, searchTerms: string[], exactTermsCount?: number, hasLatin?: boolean, hasHan?: boolean }} input
 */
export function classifyQuery(input) {
  const q = String(input.query ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!q) return "general";
  if (hasExplicitOr(q)) return "explicit_or";
  if (isQuotedPhrase(q)) return "quoted_phrase";
  if (isZhShortCompound(q)) return "zh_compound";
  if (input.phrase && input.hasLatin && !input.hasHan) return "short_entity";
  if (
    (input.exactTermsCount ?? 0) > 0 &&
    input.searchTerms.length <= 2 &&
    !input.hasHan &&
    // 含功能词的自然语言问句不进 strict technical，保留 minimum_match 回退
    !containsLatinStopword(q)
  ) {
    return "technical";
  }
  return "general";
}

/**
 * @param {{ queryClass: string, phrase?: string, terms: string[] }} input
 */
export function buildLexicalLadder(input) {
  const terms = Array.isArray(input.terms)
    ? input.terms.filter((t) => String(t ?? "").trim())
    : [];
  const phrase = String(input.phrase ?? "").trim() || undefined;
  const steps = [];

  if (input.queryClass === "explicit_or") {
    steps.push({ mode: "explicit_or", terms });
    return steps;
  }

  const shortStrict =
    input.queryClass === "zh_compound" ||
    input.queryClass === "short_entity" ||
    input.queryClass === "quoted_phrase" ||
    input.queryClass === "technical";

  const matchTerms = shortStrict ? terms : contentTermsForLexicalMatch(terms);

  if (phrase) {
    steps.push({ mode: "phrase", phrase, terms });
  }

  if (matchTerms.length > 0) {
    steps.push({ mode: "all", terms: matchTerms });
  }

  if (shortStrict) return steps;

  if (matchTerms.length >= 2) {
    // 汉字整段若已被其 bigram 覆盖，则从门槛基数中剔除（与 coverage / AND 侧一致）
    const termSet = new Set(matchTerms.map((t) => t.toLocaleLowerCase()));
    const effective = matchTerms.filter(
      (t) => !isHanRunCoveredByBigrams(t.toLocaleLowerCase(), termSet),
    );
    const zhBigrams = effective.filter(
      (t) => isHanOnlyTerm(t) && t.length === 2,
    );
    const nonZh = effective.filter(
      (t) => !(isHanOnlyTerm(t) && t.length === 2),
    );

    if (zhBigrams.length >= 2 && nonZh.length === 0) {
      const minimum = minimumShouldMatchForZhBigrams(zhBigrams.length);
      if (minimum < zhBigrams.length && minimum >= 2) {
        steps.push({
          mode: "minimum_match",
          terms: zhBigrams,
          minimum,
        });
      }
    } else {
      const minimum = minimumShouldMatchForTermCount(effective.length);
      if (minimum < effective.length && minimum >= 2) {
        steps.push({ mode: "minimum_match", terms: matchTerms, minimum });
      }
    }
  }

  return steps;
}
