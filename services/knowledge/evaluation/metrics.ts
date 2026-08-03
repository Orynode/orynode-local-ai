/**
 * 检索评测指标（ML-P0）
 */

export function recallAtK(
  ranked: string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) {
    return ranked.length === 0 ? 1 : 0;
  }
  const top = ranked.slice(0, k);
  return top.some((id) => relevant.has(id)) ? 1 : 0;
}

export function mrrAtK(
  ranked: string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) {
    return ranked.length === 0 ? 1 : 0;
  }
  const limit = Math.min(k, ranked.length);
  for (let i = 0; i < limit; i += 1) {
    if (relevant.has(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

function dcgAtK(relevances: number[], k: number): number {
  let sum = 0;
  const n = Math.min(k, relevances.length);
  for (let i = 0; i < n; i += 1) {
    const rel = relevances[i]!;
    if (rel <= 0) continue;
    sum += (2 ** rel - 1) / Math.log2(i + 2);
  }
  return sum;
}

/** 二值相关：命中=1；nDCG@k */
export function ndcgAtK(
  ranked: string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) {
    return ranked.length === 0 ? 1 : 0;
  }
  const relevances = ranked
    .slice(0, k)
    .map((id) => (relevant.has(id) ? 1 : 0));
  const dcg = dcgAtK(relevances, k);
  const ideal = dcgAtK(
    Array.from({ length: Math.min(k, relevant.size) }, () => 1),
    k,
  );
  if (ideal <= 0) return 0;
  return dcg / ideal;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx]!;
}
