/**
 * Citation 胶囊摘录：展示层用，不改正文入库。
 *
 * 旧逻辑 content.slice(0, N) 会把 PDF 页眉顶在摘录最前。
 * 这里先跳过页眉样板，再尽量围住检索词截短窗。
 */

export const CITATION_EXCERPT_MAX = 160;

/** 页眉/页脚样板（扫描教程 PDF 常见） */
export function isCitationBoilerplateLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t.length <= 2) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/\bWWW\./i.test(t)) return true;
  if (/QQ\s*[:：群]/i.test(t)) return true;
  if (/网站作品|由\s*\w+\s*整理/i.test(t)) return true;
  if (/^作者[：:]/i.test(t)) return true;
  if (/^第\s*\d+\s*页\s*$/i.test(t)) return true;
  if (/^\d{1,4}$/.test(t)) return true;
  return false;
}

/**
 * 去掉前缀页眉后，截取短摘录；有 terms 时围住首次命中。
 */
export function buildCitationExcerpt(
  content: string,
  terms: readonly string[] = [],
  maxChars = CITATION_EXCERPT_MAX,
): string {
  const raw = String(content ?? "");
  if (!raw.trim()) return "";

  // 空格折叠前先按行剥页眉；许多 PDF 解析后是单行空格串，再按「样板子串」剥前缀
  const lines = raw.split(/\r?\n/);
  let startLine = 0;
  while (
    startLine < lines.length &&
    isCitationBoilerplateLine(lines[startLine] ?? "")
  ) {
    startLine += 1;
  }
  let body = (startLine > 0 ? lines.slice(startLine).join("\n") : raw).trim();
  if (!body) body = raw.trim();

  body = stripLeadingBoilerplatePrefix(body).trim() || body;
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  let anchor = -1;
  for (const term of terms) {
    const needle = String(term ?? "").trim();
    if (needle.length < 2) continue;
    const idx = normalized.toLowerCase().indexOf(needle.toLowerCase());
    if (idx >= 0 && (anchor < 0 || idx < anchor)) anchor = idx;
  }

  if (anchor >= 0) {
    const pad = Math.min(36, Math.floor(maxChars / 4));
    const from = Math.max(0, anchor - pad);
    let snippet = normalized.slice(from, from + maxChars);
    if (from > 0) snippet = `…${snippet}`;
    if (from + maxChars < normalized.length) snippet = `${snippet}…`;
    return snippet;
  }

  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

/** 单行/空格折叠文本：剥掉开头连续的站名/QQ 等样板短语 */
function stripLeadingBoilerplatePrefix(text: string): string {
  let s = text.trimStart();
  const patterns = [
    /^WWW\.\S+\s+/i,
    /^网站作品[，,].{0,120}?整理[，,]?\s*/i,
    /^作者[：:].{0,40}?[，,]\s*/i,
    /^QQ\s*[:：]?\s*\d+\s*/i,
    /^QQ\s*群\s*[:：]?\s*\d+\s*/i,
    /^\d{1,4}\s+(?=[A-Za-z\u4e00-\u9fff{])/u, // 书内页码「37 server_…」
  ];
  let guard = 0;
  while (guard < 16) {
    guard += 1;
    let matched = false;
    for (const re of patterns) {
      const next = s.replace(re, "").trimStart();
      if (next !== s) {
        s = next;
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }
  return s;
}
