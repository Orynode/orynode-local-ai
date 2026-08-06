/**
 * FTS5 用 search_text / MATCH 查询构造（与 services/knowledge/retrieval 算法对齐）
 *
 * 词抽取保持诚实：拉丁功能词不在本层硬删（形态信号与 general 阶梯清洗在 lexical-coverage）。
 */

const MAX_SEARCH_TERMS = 40;

const SINGLE_CHAR_ALLOW = new Set(["c", "r"]);

const ZH_LOW_INFO_BIGRAMS = new Set([
  "什么",
  "如何",
  "怎么",
  "怎样",
  "一个",
  "我们",
  "你们",
  "他们",
  "这个",
  "那个",
  "可以",
  "还有",
  "以及",
  "或者",
  "如果",
  "因为",
  "所以",
  "但是",
  "然后",
  "进行",
  "通过",
  "使用",
  "需要",
  "应该",
  "是否",
  "哪些",
  "哪里",
  "为何",
  "为了",
  "关于",
  "对于",
  "时候",
  "问题",
  "一下",
  "一些",
  "一种",
  "不会",
  "没有",
  "不是",
  "就是",
  "只是",
  "还是",
]);

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractTechnicalTerms(text) {
  const normalized = String(text ?? "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  const found = new Set();
  const patterns = [
    /\bc\+\+/g,
    /\bc#/g,
    /\.net\b/g,
    /\bnode\.js\b/g,
    /\bnext\.js\b/g,
    /\bvue\.js\b/g,
    /\breact\.js\b/g,
    /\b[a-z_][\w]*(?:\.[a-z_][\w]*)+\b/g,
    /\b[a-z][\w]*(?:-[\w]+)+\b/g,
    /\bv?\d+(?:\.\d+){1,3}(?:-[a-z0-9.]+)?\b/g,
    /\b[1-5]\d{2}\b/g,
    /(?:\.?\.?\/[\w./@+-]{2,})+/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const token = match[0]?.trim();
      if (token) found.add(token);
    }
  }
  return [...found];
}

/**
 * @param {string} bigram
 */
function scoreZhBigram(bigram) {
  if (ZH_LOW_INFO_BIGRAMS.has(bigram)) return 0.4;
  return 2;
}

/**
 * @param {string} query
 * @param {number} [maxTerms]
 * @returns {string[]}
 */
export function extractSearchTerms(query, maxTerms = MAX_SEARCH_TERMS) {
  const normalized = query.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || maxTerms <= 0) return [];

  /** @type {Array<{ term: string, priority: number, kind: string }>} */
  const scored = [];
  const seen = new Set();

  /**
   * @param {string} term
   * @param {number} priority
   * @param {string} kind
   */
  const push = (term, priority, kind) => {
    if (!term || seen.has(term)) return;
    if (term.length < 2 && !SINGLE_CHAR_ALLOW.has(term)) return;
    seen.add(term);
    scored.push({ term, priority, kind });
  };

  for (const tech of extractTechnicalTerms(normalized)) {
    push(tech, 100 + Math.min(tech.length, 20), "tech");
  }

  // 非汉字字母数字词——诚实抽取，不做功能词硬删
  for (const match of normalized.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    if (/[\p{Script=Han}]/u.test(token)) continue;
    if (token.length === 1) {
      push(token, 50, "latin");
      continue;
    }
    push(token, 40 + Math.min(token.length, 10), "latin");
  }

  const hanRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  for (const run of hanRuns) {
    if (run.length >= 3) {
      push(run, 70 + Math.min(run.length, 30), "zh_phrase");
    }
    if (run.length >= 2) {
      for (let i = 0; i < run.length - 1; i += 1) {
        const bigram = run.slice(i, i + 2);
        const positionBoost = (i / Math.max(run.length - 1, 1)) * 0.5;
        push(
          bigram,
          scoreZhBigram(bigram) + positionBoost + Math.min(run.length, 8) * 0.1,
          "zh_bigram",
        );
      }
    }
  }

  scored.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (b.term.length !== a.term.length) return b.term.length - a.term.length;
    return a.term.localeCompare(b.term);
  });

  const budget = {
    tech: Math.max(4, Math.floor(maxTerms * 0.25)),
    latin: Math.max(6, Math.floor(maxTerms * 0.3)),
    zh_phrase: Math.max(4, Math.floor(maxTerms * 0.2)),
    zh_bigram: maxTerms,
  };
  const used = { tech: 0, latin: 0, zh_phrase: 0, zh_bigram: 0 };
  const out = [];

  for (const item of scored) {
    if (out.length >= maxTerms) break;
    if (used[item.kind] >= budget[item.kind]) continue;
    out.push(item.term);
    used[item.kind] += 1;
  }

  if (out.length < maxTerms) {
    const filled = new Set(out);
    for (const item of scored) {
      if (out.length >= maxTerms) break;
      if (filled.has(item.term)) continue;
      out.push(item.term);
      filled.add(item.term);
    }
  }

  return out;
}

/**
 * 原始 content 保留在业务表；search_text = 规范化正文 + 中文 bigram + 技术词扩展
 * @param {string} content
 */
export function buildSearchText(content) {
  const normalized = String(content ?? "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const extras = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = match[0];
    for (let i = 0; i < run.length - 1; i += 1) {
      extras.push(run.slice(i, i + 2));
    }
  }
  for (const tech of extractTechnicalTerms(normalized)) {
    extras.push(tech);
  }
  return extras.length > 0
    ? `${normalized} ${extras.join(" ")}`
    : normalized;
}

/**
 * @param {string} term
 */
export function escapeFtsToken(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

/**
 * @param {string[]} terms
 * @param {{ operator?: "AND" | "OR" }} [options]
 * @returns {string | null}
 */
export function buildFtsMatchQuery(terms, options = {}) {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  const operator = options.operator === "OR" ? "OR" : "AND";
  return terms.map(escapeFtsToken).join(` ${operator} `);
}
