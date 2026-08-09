import type { RetrievalHit } from "../types";

export function isTocQueryIntent(query: string): boolean {
  return /(?:目录|章节|索引|大纲|contents|table\s+of\s+contents|outline)/i.test(
    query,
  );
}

export function isLikelyTocChunk(
  chunk: Pick<RetrievalHit, "content" | "pageNumber">,
): boolean {
  const content = chunk.content.replace(/\s+/g, " ").trim();
  if (!content) return false;

  const dottedEntries =
    content.match(
      /[^。！？；]{2,80}?(?:\.{1,3}|．{1,3}|…+|·{2,})\s*\d{1,4}(?=\s|$)/g,
    )?.length ?? 0;
  const numberedEntries =
    content.match(
      /(?:^|\s)(?:\d{1,2}[.、]|[一二三四五六七八九十]+[、.])\s*\S{2,30}/g,
    )?.length ?? 0;
  const hasTocHeading = /(?:^|\s)(?:目录|contents)(?:\s|$)/i.test(content);
  const proseSignals =
    content.match(/(?:是指|是一种|定义为|所谓|因此|例如|。|！|？)/g)?.length ??
    0;

  if (dottedEntries >= 3) return true;
  if (hasTocHeading && dottedEntries + numberedEntries >= 2) return true;
  return (
    chunk.pageNumber <= 8 &&
    dottedEntries + numberedEntries >= 4 &&
    proseSignals <= 2
  );
}

/**
 * 正文候选存在时稳定地把目录候选移到末尾；仅命中目录时仍保留结果。
 */
export function rankTocAfterBody(
  hits: RetrievalHit[],
  query: string,
  topK: number,
): RetrievalHit[] {
  if (hits.length <= 1 || isTocQueryIntent(query)) return hits.slice(0, topK);
  const body: RetrievalHit[] = [];
  const toc: RetrievalHit[] = [];
  for (const hit of hits) {
    (isLikelyTocChunk(hit) ? toc : body).push(hit);
  }
  if (body.length === 0) return hits.slice(0, topK);
  return [...body, ...toc].slice(0, topK);
}
