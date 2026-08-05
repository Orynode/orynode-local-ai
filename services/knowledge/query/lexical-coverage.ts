/**
 * 词法覆盖率（QS-002 / §5）：中英共用，禁止「任意一词即命中」。
 */

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
 * 英文有效词数 → minimum_should_match（QS §5.1）
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
 * 中文 bigram 数 → 最低覆盖（QS §5.2）
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

/** 短复合：单一连续汉字 2–6 字（术语/实体；长问句走 general） */
export function isZhShortCompound(query: string): boolean {
  const trimmed = String(query ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 6) return false;
  return /^[\p{Script=Han}]{2,6}$/u.test(trimmed);
}

export function hasExplicitOr(query: string): boolean {
  return /\bOR\b/i.test(String(query ?? ""));
}

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
 * 用于 minimum_match 准入过滤。
 */
export function countTermCoverage(
  content: string,
  terms: string[],
): number {
  const hay = String(content ?? "").toLocaleLowerCase();
  if (!hay || !Array.isArray(terms) || terms.length === 0) return 0;
  let hit = 0;
  const seen = new Set<string>();
  for (const raw of terms) {
    const term = String(raw ?? "").toLocaleLowerCase().trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
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
    !input.hasHan
  ) {
    return "technical";
  }
  return "general";
}

/**
 * 构造可执行词法阶梯。短实体 / 中文短复合：phrase → all，禁止降到任意一词。
 * 一般查询：all → minimum_match；显式 OR：仅 explicit_or。
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

  if (shortStrict) {
    // 短实体：AND 失败即交给语义，不进 minimum_match 放宽
    return steps;
  }

  if (terms.length >= 2) {
    const zhBigrams = terms.filter(
      (t) => isHanOnlyTerm(t) && t.length === 2,
    );
    const nonZh = terms.filter(
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
      // 英文 / 中英混合：按全词 minimum_should_match（技术词保留在 terms 内）
      const minimum = minimumShouldMatchForTermCount(terms.length);
      if (minimum < terms.length && minimum >= 2) {
        steps.push({ mode: "minimum_match", terms, minimum });
      }
    }
  }

  return steps;
}
