/**
 * FTS5 search_text 构造（与 scripts/data-service/search-text.mjs 对齐）
 */

import { extractSearchTerms, extractTechnicalTerms } from "./keyword";

/** heading_path 可能是数组或 SQLite 里的 JSON 字符串 */
export function normalizeHeadingPath(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((part) => String(part).trim()).filter(Boolean);
  }
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((part) => String(part).trim()).filter(Boolean);
      }
    } catch {
      // 当普通标题
    }
  }
  return text
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 索引与重排用的处境化正文：标题栈 + 切片。不改业务表 content。
 */
export function contextualizeChunkText(
  content: string,
  headingPath?: unknown,
): string {
  const body = String(content ?? "").trim();
  const parts = normalizeHeadingPath(headingPath);
  const heading = parts.join(" / ");
  if (!heading) return body;
  if (!body) return heading;
  const last = parts.at(-1);
  if (last && (body.startsWith(`# ${last}`) || body.startsWith(heading))) {
    return body;
  }
  return `${heading}\n\n${body}`;
}

export function buildSearchText(
  content: string,
  headingPath?: unknown,
): string {
  const normalized = contextualizeChunkText(content, headingPath)
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

/** FTS5 unicode61: 3+ 汉字不是 token；MATCH 只用拉丁词与 2 字汉字。 */
export function termsForFts5Match(terms: string[]): string[] {
  return (Array.isArray(terms) ? terms : [])
    .map((term) => String(term ?? "").trim())
    .filter((term) => term && !/^[\p{Script=Han}]{3,}$/u.test(term));
}

export function buildFtsMatchQuery(
  terms: string[],
  options: { operator?: "AND" | "OR" } = {},
): string | null {
  if (!Array.isArray(terms) || terms.length === 0) return null;
  const operator = options.operator === "OR" ? "OR" : "AND";
  return terms.map(escapeFtsToken).join(` ${operator} `);
}

export function buildFtsMatchQueryFromUserQuery(query: string): string | null {
  return buildFtsMatchQuery(extractSearchTerms(query));
}
