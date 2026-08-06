/**
 * 词法覆盖率（中英共用）：禁止「任意一词即命中」。
 * 阶梯与功能词契约见 docs/ARCHITECTURE_zh-CN.md「词法召回契约」。
 */

import {
  containsLatinStopword,
  contentTermsForLexicalMatch,
} from "./latin-stopwords";

export type LexicalMatchMode = "phrase" | "all" | "minimum_match" | "explicit_or";

export type QueryClass =
  | "quoted_phrase"
  | "short_entity"
  | "technical"
  | "zh_compound"
  | "general"
  | "explicit_or";

export type LexicalLadderStep = {
  mode: LexicalMatchMode;
  /** mode=phrase 时的完整短语 */
  phrase?: string;
  terms: string[];
  /** mode=minimum_match 时至少命中词数 */
  minimum?: number;
};

/**
 * 英文有效词数 → minimum_should_match
 */
export function minimumShouldMatchForTermCount(termCount: number): number {
  const n = Math.max(0, Math.floor(termCount));
  if (n <= 0) return 0;
  if (n <= 2) return n;
  if (n <= 4) return Math.ceil(n * 0.75);
  if (n <= 8) return Math.ceil(n * 0.6);
  return Math.max(1, Math.ceil(n * 0.5));
}

/**
 * 中文 bigram 数 → 最低覆盖
 * 2–3：全部；4–6：≥75%；更长：60%（核心 MUST 由上层 AND 步承担）
 */
export function minimumShouldMatchForZhBigrams(bigramCount: number): number {
  const n = Math.max(0, Math.floor(bigramCount));
  if (n <= 0) return 0;
  if (n <= 3) return n;
  if (n <= 6) return Math.ceil(n * 0.75);
  return Math.ceil(n * 0.6);
}

export function isHanOnlyTerm(term: string): boolean {
  return /^[\p{Script=Han}]+$/u.test(String(term ?? "").trim());
}

/**
 * 汉字整段（≥3 字）若其全部 bigram 已在词表中，则视为被 bigram 覆盖：
 * coverage 计数与 minimum 门槛均不重复计入，与 AND 侧 termsForAndMatch 对齐。
 */
export function isHanRunCoveredByBigrams(
  term: string,
  termSet: ReadonlySet<string>,
): boolean {
  const t = String(term ?? "").trim();
  if (!/^[\p{Script=Han}]{3,}$/u.test(t)) return false;
  for (let i = 0; i < t.length - 1; i += 1) {
    if (!termSet.has(t.slice(i, i + 2))) return false;
  }
  return true;
}

/** 短复合：单一连续汉字 2–6 字（术语/实体；长问句走 general） */
export function isZhShortCompound(query: string): boolean {
  const trimmed = String(query ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 6) return false;
  return /^[\p{Script=Han}]{2,6}$/u.test(trimmed);
}

export function hasExplicitOr(query: string): boolean {
  return /\bOR\b/i.test(String(query ?? ""));
}

export { containsLatinStopword, isLatinStopword } from "./latin-stopwords";

export function isQuotedPhrase(query: string): boolean {
  const trimmed = String(query ?? "").replace(/\s+/g, " ").trim();
  return (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 2) ||
    (trimmed.startsWith("「") && trimmed.endsWith("」") && trimmed.length > 2)
  );
}

/**
 * 统计 content 中命中了多少 query terms（子串，大小写不敏感）。
 * 用于 minimum_match 准入过滤；按 bigram 计数时，
 * 已被其 bigram 覆盖的汉字整段不双重计分。
 */
export function countTermCoverage(
  content: string,
  terms: string[],
): number {
  const hay = String(content ?? "").toLocaleLowerCase();
  if (!hay || !Array.isArray(terms) || terms.length === 0) return 0;
  let hit = 0;
  const seen = new Set<string>();
  const lowered = terms
    .map((raw) => String(raw ?? "").toLocaleLowerCase().trim())
    .filter(Boolean);
  const termSet = new Set(lowered);
  for (const term of lowered) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    if (isHanRunCoveredByBigrams(term, termSet)) continue;
    if (hay.includes(term)) hit += 1;
  }
  return hit;
}

export function passesCoverage(
  content: string,
  terms: string[],
  minimum: number,
): boolean {
  const min = Math.max(1, Math.floor(minimum));
  return countTermCoverage(content, terms) >= min;
}

export type ClassifyQueryInput = {
  query: string;
  phrase?: string;
  searchTerms: string[];
  exactTermsCount?: number;
  hasLatin?: boolean;
  hasHan?: boolean;
};

export function classifyQuery(input: ClassifyQueryInput): QueryClass {
  const q = String(input.query ?? "").replace(/\s+/g, " ").trim();
  if (!q) return "general";
  if (hasExplicitOr(q)) return "explicit_or";
  if (isQuotedPhrase(q)) return "quoted_phrase";
  if (isZhShortCompound(q)) return "zh_compound";
  if (
    input.phrase &&
    input.hasLatin &&
    !input.hasHan
  ) {
    return "short_entity";
  }
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
 * 构造可执行词法阶梯。短实体 / 中文短复合：phrase → all，禁止降到任意一词。
 * 一般查询：all → minimum_match；显式 OR：仅 explicit_or。
 * general 的 AND/minimum 步使用内容词（去功能词），searchTerms 本身保持诚实抽取。
 */
export function buildLexicalLadder(input: {
  queryClass: QueryClass;
  phrase?: string;
  terms: string[];
}): LexicalLadderStep[] {
  const terms = Array.isArray(input.terms)
    ? input.terms.filter((t) => String(t ?? "").trim())
    : [];
  const phrase = String(input.phrase ?? "").trim() || undefined;
  const steps: LexicalLadderStep[] = [];

  if (input.queryClass === "explicit_or") {
    steps.push({ mode: "explicit_or", terms });
    return steps;
  }

  const shortStrict =
    input.queryClass === "zh_compound" ||
    input.queryClass === "short_entity" ||
    input.queryClass === "quoted_phrase" ||
    input.queryClass === "technical";

  // general：匹配词去功能词；strict / phrase 步仍用完整 terms（与抽取诚实一致）
  const matchTerms = shortStrict ? terms : contentTermsForLexicalMatch(terms);

  if (phrase) {
    steps.push({ mode: "phrase", phrase, terms });
  }

  if (matchTerms.length > 0) {
    steps.push({ mode: "all", terms: matchTerms });
  }

  if (shortStrict) {
    // 短实体：AND 失败即交给语义，不进 minimum_match 放宽
    return steps;
  }

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
      // 纯中文：按 bigram 覆盖率
      const minimum = minimumShouldMatchForZhBigrams(zhBigrams.length);
      if (minimum < zhBigrams.length && minimum >= 2) {
        steps.push({
          mode: "minimum_match",
          terms: zhBigrams,
          minimum,
        });
      }
    } else {
      // 英文 / 中英混合：按有效词（去重后）minimum_should_match
      const minimum = minimumShouldMatchForTermCount(effective.length);
      if (minimum < effective.length && minimum >= 2) {
        steps.push({ mode: "minimum_match", terms: matchTerms, minimum });
      }
    }
  }

  return steps;
}
