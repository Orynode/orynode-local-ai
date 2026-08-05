/**
 * Query Rewrite 类型与排除过滤。
 * 开放世界改写入口只有 resolveQueryRewrite（术语库 → LLM → 晋升）。
 */

import { containsTerm } from "./terminology-match";

export type QueryRewriteSource = "none" | "terminology" | "llm";

export type StructuredQueryRewrite = {
  source: QueryRewriteSource;
  domain?: string;
  /** 完整同义短语；禁止再拆成单词 OR */
  synonyms: string[];
  exclude: string[];
  matchedEntryIds: string[];
};

/**
 * 排除过滤：正文含排除短语且不含任何正例短语 → 丢弃。
 * 匹配规则与术语库一致（containsTerm：汉字子串 / 拉丁词界）。
 */
export function applyRewriteExcludes<T extends { content?: string }>(
  hits: T[],
  positives: string[],
  excludes: string[],
): T[] {
  if (!excludes.length) return hits;
  const pos = positives.map((p) => p.trim()).filter(Boolean);
  const ex = excludes.map((e) => e.trim()).filter(Boolean);
  if (ex.length === 0) return hits;

  return hits.filter((hit) => {
    const hay = String(hit.content ?? "");
    if (pos.some((p) => containsTerm(hay, p))) return true;
    if (ex.some((e) => containsTerm(hay, e))) return false;
    return true;
  });
}
