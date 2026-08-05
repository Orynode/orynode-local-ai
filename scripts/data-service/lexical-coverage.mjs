/**
 * 词法覆盖率（与 services/knowledge/query/lexical-coverage.ts 对齐）
 */

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
 * @param {string} content
 * @param {string[]} terms
 */
export function countTermCoverage(content, terms) {
  const hay = String(content ?? "").toLocaleLowerCase();
  if (!hay || !Array.isArray(terms) || terms.length === 0) return 0;
  let hit = 0;
  const seen = new Set();
  for (const raw of terms) {
    const term = String(raw ?? "")
      .toLocaleLowerCase()
      .trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
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
    !input.hasHan
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

  if (phrase) {
    steps.push({ mode: "phrase", phrase, terms });
  }

  if (terms.length > 0) {
    steps.push({ mode: "all", terms });
  }

  const shortStrict =
    input.queryClass === "zh_compound" ||
    input.queryClass === "short_entity" ||
    input.queryClass === "quoted_phrase" ||
    input.queryClass === "technical";

  if (shortStrict) return steps;

  if (terms.length >= 2) {
    const zhBigrams = terms.filter(
      (t) => isHanOnlyTerm(t) && t.length === 2,
    );
    const nonZh = terms.filter(
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
      const minimum = minimumShouldMatchForTermCount(terms.length);
      if (minimum < terms.length && minimum >= 2) {
        steps.push({ mode: "minimum_match", terms, minimum });
      }
    }
  }

  return steps;
}
