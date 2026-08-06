/**
 * 词法覆盖率（与 services/knowledge/query/lexical-coverage.ts + latin-stopwords.ts 对齐）
 *
 * 拉丁功能词仅作：分类形态信号 + general 阶梯匹配词清洗。
 * 不在 search-text.extractSearchTerms 硬删。
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

/**
 * @param {string[]} terms
 */
export function contentTermsForLexicalMatch(terms) {
  const raw = Array.isArray(terms)
    ? terms.map((t) => String(t ?? "").trim()).filter(Boolean)
    : [];
  if (raw.length === 0) return [];
  const content = raw.filter((t) => !isLatinStopword(t));
  return content.length > 0 ? content : raw;
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
