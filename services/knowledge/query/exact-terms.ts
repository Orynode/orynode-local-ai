/**
 * Exact term 抽取（文件名、错误码、符号、引号短语）
 */

import { detectQueryKind, type QueryKind } from "../retrieval/query-type";

export type ExactTermKind =
  | "filename"
  | "error_code"
  | "symbol"
  | "quoted"
  | "product";

export interface ExactTerm {
  value: string;
  kind: ExactTermKind;
  weight: number;
}

const WEIGHT: Record<ExactTermKind, number> = {
  filename: 2.0,
  error_code: 2.0,
  symbol: 1.8,
  quoted: 1.6,
  product: 1.4,
};

const PRODUCT =
  /\b(?:orynode|openai|anthropic|sqlite|fts5|nodejs|node\.js|typescript|javascript)\b/gi;

/**
 * 从用户查询抽取精确检索词；不修改原查询。
 */
export function extractExactTerms(query: string): ExactTerm[] {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];

  const out: ExactTerm[] = [];
  const seen = new Set<string>();

  const push = (value: string, kind: ExactTermKind) => {
    const v = value.trim();
    if (!v || seen.has(v.toLocaleLowerCase())) return;
    seen.add(v.toLocaleLowerCase());
    out.push({ value: v, kind, weight: WEIGHT[kind] });
  };

  const kind = detectQueryKind(trimmed);
  if (kind === "exact_phrase") {
    const bare = trimmed.replace(/^["'`「]|["'`」]$/g, "");
    push(bare, "quoted");
    return out;
  }
  if (kind === "filename") {
    push(trimmed.replace(/^["'`「]|["'`」]$/g, ""), "filename");
    return out;
  }
  if (kind === "error_code") {
    push(trimmed.replace(/^["'`「]|["'`」]$/g, ""), "error_code");
    return out;
  }
  if (kind === "symbol") {
    push(trimmed.replace(/^`|`$/g, ""), "symbol");
    return out;
  }

  // general：仍抽取内嵌精确片段
  for (const match of trimmed.matchAll(/["「]([^"」]{2,})["」]/g)) {
    push(match[1]!, "quoted");
  }
  for (const match of trimmed.matchAll(
    /\b(?:ERR_[A-Z0-9_]+|E[A-Z]{2,}[A-Z0-9_]*)\b/g,
  )) {
    push(match[0]!, "error_code");
  }
  for (const match of trimmed.matchAll(PRODUCT)) {
    push(match[0]!, "product");
  }
  for (const match of trimmed.matchAll(
    /\b[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+(?:\(\))?\b/g,
  )) {
    push(match[0]!, "symbol");
  }

  return out;
}

export function queryKindToExactKind(kind: QueryKind): ExactTermKind | null {
  switch (kind) {
    case "exact_phrase":
      return "quoted";
    case "filename":
      return "filename";
    case "error_code":
      return "error_code";
    case "symbol":
      return "symbol";
    default:
      return null;
  }
}
