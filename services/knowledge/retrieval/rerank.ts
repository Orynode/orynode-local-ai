/**
 * 轻量本地 rerank：无独立模型时用关键词重叠打分（Quality 降级路径）
 *
 * ADR-ML-005：无语义 reranker 时 lexical 不得用全零分覆盖融合顺序；
 * 有非零分时仅作有限 boost，不把字面重合分当作最终排序分。
 */

import type { RerankItem, RerankerPort } from "../ports/models";
import { extractSearchTerms, keywordScore } from "./keyword";

/** 显式无模型；isAvailable → false */
export class UnavailableReranker implements RerankerPort {
  readonly modelName = "none";
  async isAvailable() {
    return false;
  }
  async rerank() {
    return [];
  }
}

export type LexicalRerankResult = {
  items: Array<{ id: string; score: number }>;
  /** true：全部字面分为 0，调用方必须保持原融合顺序与分数 */
  preservedOrder: boolean;
};

/** 规则打分 rerank，不加载 ONNX；capability type = lexical */
export class LexicalReranker implements RerankerPort {
  readonly modelName = "lexical-overlap";
  readonly capabilityType = "lexical" as const;
  async isAvailable() {
    return true;
  }
  async rerank(
    query: string,
    items: RerankItem[],
    topK: number,
  ): Promise<Array<{ id: string; score: number }>> {
    const result = this.rerankWithMeta(query, items, topK);
    return result.items;
  }

  /** 供 pipeline 区分「全零保序」与「有限 boost」 */
  rerankWithMeta(
    query: string,
    items: RerankItem[],
    topK: number,
  ): LexicalRerankResult {
    const terms = extractSearchTerms(query);
    const scored = items.map((item, index) => ({
      id: item.id,
      score: keywordScore(item.text, terms),
      index,
    }));
    const anyPositive = scored.some((row) => row.score > 0);
    if (!anyPositive) {
      return {
        preservedOrder: true,
        items: items.slice(0, topK).map((item) => ({ id: item.id, score: 0 })),
      };
    }
    return {
      preservedOrder: false,
      items: scored
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, topK)
        .map(({ id, score }) => ({ id, score })),
    };
  }
}

export function resolveReranker(preferModel: boolean): RerankerPort {
  if (preferModel) {
    // Phase 4：尚无 Transformers reranker 安装；Quality 用 lexical
    return new LexicalReranker();
  }
  return new UnavailableReranker();
}

/**
 * 将 lexical 分作为有限 boost 叠到融合分上，不覆盖原分。
 * maxBoost 默认 0.05（相对当前最高融合分的比例）。
 */
export function applyLexicalBoost(
  hits: Array<{ id: string; score: number }>,
  lexicalScores: Array<{ id: string; score: number }>,
  maxBoost = 0.05,
): Array<{ id: string; score: number }> {
  if (hits.length === 0) return hits;
  const lexMap = new Map(lexicalScores.map((row) => [row.id, row.score]));
  const maxLex = Math.max(0, ...lexicalScores.map((row) => row.score));
  if (maxLex <= 0) return hits;

  const maxFusion = Math.max(...hits.map((h) => h.score), 1e-9);
  return [...hits]
    .map((hit) => {
      const lex = lexMap.get(hit.id) ?? 0;
      const boost = maxBoost * maxFusion * (lex / maxLex);
      return { ...hit, score: hit.score + boost };
    })
    .sort((a, b) => b.score - a.score);
}
