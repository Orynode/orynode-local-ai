/**
 * 本地高置信跨语言术语表。
 *
 * 同一事实同时服务 QueryPlanner 与 UI 高亮，避免“能高亮但不能召回”。
 * 这里只放无上下文歧义较小的内置词；后续可替换为可版本化用户术语表。
 */

export interface TerminologyEntry {
  id: string;
  terms: readonly string[];
}

export const BUILTIN_TERMINOLOGY: readonly TerminologyEntry[] = [
  { id: "sodium-ion", terms: ["钠离子", "sodium", "sodium-ion", "na-ion", "na+"] },
  { id: "lithium-ion", terms: ["锂离子", "lithium", "lithium-ion", "li-ion", "li+"] },
  { id: "electrolyte", terms: ["电解质", "electrolyte", "electrolytes"] },
  { id: "solvation", terms: ["溶剂化", "solvation", "solvate", "solvated"] },
  { id: "kinetics", terms: ["动力学", "dynamics", "kinetic", "kinetics"] },
  { id: "ion-transport", terms: ["离子传输", "ion transport"] },
  { id: "atomic-scale", terms: ["原子尺度", "atomistic", "atomic-scale"] },
  { id: "keyword", terms: ["关键词", "关键字", "keyword", "keywords"] },
] as const;

function containsTerm(text: string, term: string): boolean {
  const normalized = text.toLocaleLowerCase();
  const needle = term.toLocaleLowerCase();
  if (/\p{Script=Han}/u.test(needle)) return normalized.includes(needle);

  // 拉丁术语必须落在词边界，避免 keyword 命中 keywording 一类片段。
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(
    normalized,
  );
}

/** 返回与输入中已出现术语同组、但未原样出现的对应词。 */
export function expandTerminology(text: string, maxTerms = 12): string[] {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || maxTerms <= 0) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of BUILTIN_TERMINOLOGY) {
    if (!entry.terms.some((term) => containsTerm(trimmed, term))) continue;
    for (const term of entry.terms) {
      if (containsTerm(trimmed, term)) continue;
      const key = term.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(term);
      if (out.length >= maxTerms) return out;
    }
  }
  return out;
}
