/**
 * 规则多查询：不依赖 LLM，从原句派生变体供并行召回
 */

import { SEARCH_CONFIG } from "../../../config/defaults";
import { extractSearchTerms } from "./keyword";
import { shouldExpandQuery } from "./query-type";

/**
 * 返回含原句在内的查询列表（去重、保序）。
 * 精确类查询（文件名 / 错误码 / 符号 / 引号短语）不扩展。
 * 变体上限由 maxVariants 控制（默认 2，即最多原句 + 2）。
 */
export function buildMultiQueries(
  query: string,
  maxVariants = SEARCH_CONFIG.multiQueryVariants,
): string[] {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];

  if (!shouldExpandQuery(trimmed)) {
    return [trimmed];
  }

  const out: string[] = [trimmed];
  const terms = extractSearchTerms(trimmed);
  const limit = Math.max(0, maxVariants) + 1;

  if (terms.length >= 2) {
    const keywordQuery = terms.slice(0, 8).join(" ");
    if (keywordQuery && keywordQuery !== trimmed) out.push(keywordQuery);
  }

  if (terms.length >= 1 && out.length < limit) {
    const longest = [...terms].sort((a, b) => b.length - a.length)[0];
    if (longest && !out.includes(longest)) out.push(longest);
  }

  return out.slice(0, limit);
}
