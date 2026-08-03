/**
 * 关键词召回与 RRF 融合（纯函数，无 I/O）
 *
 * 对齐 docs/knowledge-engine/MULTILINGUAL_RETRIEVAL_ARCHITECTURE_zh-CN.md：
 * - 英文/技术词用 Unicode + 技术 tokenizer，保留 C++ / Node.js 等
 * - 中文按信息量预算选词，避免长问句 bigram 挤掉核心词
 */

import { SEARCH_CONFIG } from "../../../config/defaults";

/** 技术语境下允许保留的单字符词 */
const SINGLE_CHAR_ALLOW = new Set(["c", "r"]);

/**
 * 低信息中文 bigram：只降权，不从精确短语中删除。
 * 停用词不得在 exact phrase 路径直接剔除。
 */
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

type ScoredTerm = {
  term: string;
  /** 越大越优先进入 maxSearchTerms 预算 */
  priority: number;
  kind: "tech" | "latin" | "zh_phrase" | "zh_bigram";
};

/** 抽取技术标识符：C++、C#、.NET、Node.js、路径、版本号等 */
export function extractTechnicalTerms(text: string): string[] {
  const normalized = String(text ?? "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  const found = new Set<string>();
  const patterns: RegExp[] = [
    /\bc\+\+/g,
    /\bc#/g,
    /\.net\b/g,
    /\bnode\.js\b/g,
    /\bnext\.js\b/g,
    /\bvue\.js\b/g,
    /\breact\.js\b/g,
    // dotted / kebab 标识（至少一段分隔）
    /\b[a-z_][\w]*(?:\.[a-z_][\w]*)+\b/g,
    /\b[a-z][\w]*(?:-[\w]+)+\b/g,
    // 版本号
    /\bv?\d+(?:\.\d+){1,3}(?:-[a-z0-9.]+)?\b/g,
    // HTTP 状态码
    /\b[1-5]\d{2}\b/g,
    // 简易路径
    /(?:\.?\.?\/[\w./@+-]{2,})+/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const token = match[0]?.trim();
      if (token && token.length >= 1) found.add(token);
    }
  }
  return [...found];
}

function scoreZhBigram(bigram: string): number {
  if (ZH_LOW_INFO_BIGRAMS.has(bigram)) return 0.4;
  return 2;
}

/**
 * 从查询抽取检索词，按信息量与词类预算截断（非出现顺序）。
 */
export function extractSearchTerms(
  query: string,
  maxTerms = SEARCH_CONFIG.maxSearchTerms,
): string[] {
  const normalized = query.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || maxTerms <= 0) return [];

  const scored: ScoredTerm[] = [];
  const seen = new Set<string>();

  const push = (term: string, priority: number, kind: ScoredTerm["kind"]) => {
    if (!term || seen.has(term)) return;
    if (term.length < 2 && !SINGLE_CHAR_ALLOW.has(term)) return;
    seen.add(term);
    scored.push({ term, priority, kind });
  };

  // 1) 技术词：最高优先，保留标点形态
  for (const tech of extractTechnicalTerms(normalized)) {
    push(tech, 100 + Math.min(tech.length, 20), "tech");
  }

  // 2) 非汉字字母数字词（Unicode Letter，排除 Han）
  for (const match of normalized.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    if (/[\p{Script=Han}]/u.test(token)) continue;
    // 已作为技术词收录的跳过（如 node 可能被 node.js 覆盖，仍保留独立词有益）
    if (token.length === 1) {
      push(token, 50, "latin");
      continue;
    }
    push(token, 40 + Math.min(token.length, 10), "latin");
  }

  // 3) 中文：以非汉字为边界分段；短语优先，bigram 按信息量
  const hanRuns = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  for (const run of hanRuns) {
    if (run.length >= 3) {
      // 核心短语：整段优先于其 bigram
      push(run, 70 + Math.min(run.length, 30), "zh_phrase");
    }
    if (run.length >= 2) {
      for (let i = 0; i < run.length - 1; i += 1) {
        const bigram = run.slice(i, i + 2);
        // 后半段略加权，缓解「核心词在长问句后部」被截断
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

  // 词类预算：避免某一类占满名额
  const budget = {
    tech: Math.max(4, Math.floor(maxTerms * 0.25)),
    latin: Math.max(6, Math.floor(maxTerms * 0.3)),
    zh_phrase: Math.max(4, Math.floor(maxTerms * 0.2)),
    zh_bigram: maxTerms,
  };
  const used = { tech: 0, latin: 0, zh_phrase: 0, zh_bigram: 0 };
  const out: string[] = [];

  for (const item of scored) {
    if (out.length >= maxTerms) break;
    if (used[item.kind] >= budget[item.kind]) continue;
    out.push(item.term);
    used[item.kind] += 1;
  }

  // 预算用尽后若仍有空位，按优先级补齐
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

export function keywordScore(chunkContent: string, terms: string[]): number {
  const content = chunkContent.toLocaleLowerCase();
  let score = 0;
  for (const term of terms) {
    let pos = content.indexOf(term);
    while (pos !== -1) {
      score += term.length;
      pos = content.indexOf(term, pos + term.length);
    }
  }
  return score;
}

/** RRF：按排名 rank（从 0 起）加权，而不是 chunk 下标 */
export function rrfFusion(
  rankedIdLists: string[][],
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranked of rankedIdLists) {
    ranked.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

/**
 * 带权 RRF（ADR-ML / §8.2）。lists 与 weights 按下标对齐；缺省权重为 1。
 */
export function weightedRrfFusion(
  rankedIdLists: string[][],
  weights: number[] = [],
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  rankedIdLists.forEach((ranked, listIndex) => {
    const weight = weights[listIndex] ?? 1;
    ranked.forEach((id, rank) => {
      scores.set(
        id,
        (scores.get(id) ?? 0) + weight / (k + rank + 1),
      );
    });
  });
  return scores;
}
