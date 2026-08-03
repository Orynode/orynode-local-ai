/**
 * FTS5 search_text 构造（与 scripts/data-service/search-text.mjs 对齐）
 */

import { extractSearchTerms, extractTechnicalTerms } from "./keyword";

export function buildSearchText(content: string): string {
  const normalized = String(content ?? "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const extras: string[] = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = match[0];
    for (let i = 0; i < run.length - 1; i += 1) {
      extras.push(run.slice(i, i + 2));
    }
  }
  // 技术标识整词写入索引，避免 unicode61 把 Node.js / C++ 拆碎
  for (const tech of extractTechnicalTerms(normalized)) {
    extras.push(tech);
  }

  return extras.length > 0
    ? `${normalized} ${extras.join(" ")}`
    : normalized;
}

export function escapeFtsToken(term: string): string {
  return `"${String(term).replace(/"/g, '""')}"`;
}

export function buildFtsMatchQuery(terms: string[]): string | null {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  return terms.map(escapeFtsToken).join(" OR ");
}

export function buildFtsMatchQueryFromUserQuery(query: string): string | null {
  return buildFtsMatchQuery(extractSearchTerms(query));
}
