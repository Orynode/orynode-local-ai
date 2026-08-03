import type { ReactNode } from "react";

/**
 * 从查询抽出适合 UI 高亮的词项（轻量客户端版；优先使用 API highlightTerms）。
 */
export function extractHighlightTerms(query: string, maxTerms = 12): string[] {
  const normalized = query.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const seen = new Set<string>();
  const terms: string[] = [];

  const push = (term: string) => {
    const t = term.trim();
    if (!t || seen.has(t.toLocaleLowerCase())) return;
    if (t.length < 2 && !/^[a-z0-9]$/i.test(t)) return;
    seen.add(t.toLocaleLowerCase());
    terms.push(t);
  };

  push(normalized);

  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._+-]*/gi)) {
    push(match[0].toLocaleLowerCase());
  }

  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    push(run);
    if (run.length >= 3) {
      for (let i = 0; i < run.length - 1; i += 1) {
        push(run.slice(i, i + 2));
      }
    }
  }

  terms.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return terms.slice(0, maxTerms);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  out.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return out;
}

/** 在全文中找最早出现的任一高亮词，返回匹配起点；无匹配则 -1。 */
export function findFirstMatchIndex(content: string, terms: string[]): number {
  if (!content || terms.length === 0) return -1;
  const lower = content.toLocaleLowerCase();
  let best = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLocaleLowerCase());
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

export function hasLexicalHighlight(
  content: string,
  queryOrTerms: string | string[],
): boolean {
  const terms = Array.isArray(queryOrTerms)
    ? normalizeTerms(queryOrTerms)
    : extractHighlightTerms(queryOrTerms);
  return findFirstMatchIndex(content, terms) >= 0;
}

/** 以首个匹配为中心截取片段，尽量保留上下文。 */
export function sliceAroundMatch(
  content: string,
  matchIndex: number,
  maxLen: number,
): { text: string; prefixEllipsis: boolean; suffixEllipsis: boolean } {
  if (content.length <= maxLen) {
    return { text: content, prefixEllipsis: false, suffixEllipsis: false };
  }
  if (matchIndex < 0) {
    return {
      text: content.slice(0, maxLen),
      prefixEllipsis: false,
      suffixEllipsis: content.length > maxLen,
    };
  }

  const half = Math.floor(maxLen / 2);
  let start = Math.max(0, matchIndex - half);
  let end = start + maxLen;
  if (end > content.length) {
    end = content.length;
    start = Math.max(0, end - maxLen);
  }
  return {
    text: content.slice(start, end),
    prefixEllipsis: start > 0,
    suffixEllipsis: end < content.length,
  };
}

function renderHighlightedText(text: string, terms: string[]): ReactNode {
  if (terms.length === 0 || !text) return text;

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);

  return parts.map((part, index) => {
    if (!part) return null;
    const isHit = terms.some(
      (term) => part.toLocaleLowerCase() === term.toLocaleLowerCase(),
    );
    if (isHit) {
      return (
        <mark key={`h-${index}`} className="knowledge-search-mark">
          {part}
        </mark>
      );
    }
    return <span key={`t-${index}`}>{part}</span>;
  });
}

/** 高亮标题/短文本（不截断）。 */
export function highlightSearchText(
  text: string,
  queryOrTerms: string | string[],
): ReactNode {
  const terms = Array.isArray(queryOrTerms)
    ? normalizeTerms(queryOrTerms)
    : extractHighlightTerms(queryOrTerms);
  return renderHighlightedText(text, terms);
}

/**
 * 将 snippet 中与 query/terms 匹配的片段包成 <mark>。
 * 支持跨语言词项（由 API highlightTerms 提供英文对应）。
 */
export function highlightSearchSnippet(
  content: string,
  queryOrTerms: string | string[],
  maxLen = 280,
): ReactNode {
  const terms = Array.isArray(queryOrTerms)
    ? normalizeTerms(queryOrTerms)
    : extractHighlightTerms(queryOrTerms);
  const matchIndex = findFirstMatchIndex(content, terms);
  const { text, prefixEllipsis, suffixEllipsis } = sliceAroundMatch(
    content,
    matchIndex,
    maxLen,
  );

  return (
    <>
      {prefixEllipsis ? "…" : null}
      {renderHighlightedText(text, terms)}
      {suffixEllipsis ? "…" : null}
    </>
  );
}
