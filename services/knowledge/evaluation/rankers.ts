/**
 * 离线评测 ranker（无 I/O；对齐当前 keyword / planner / lexical 行为）
 */

import { buildMultilingualFields } from "../indexing/multilingual-normalizer";
import { planQuery } from "../query/planner";
import {
  extractSearchTerms,
  keywordScore,
  weightedRrfFusion,
} from "../retrieval/keyword";
import {
  applyLexicalBoost,
  LexicalReranker,
} from "../retrieval/rerank";
import type { EvalChunk, RankerStrategyId } from "./types";

export type RankFn = (query: string, corpus: EvalChunk[]) => string[];

function scoreRaw(query: string, text: string): number {
  return keywordScore(text, extractSearchTerms(query));
}

function scoreMultilingualFields(query: string, text: string): number {
  const fields = buildMultilingualFields(text);
  const haystack = [
    text,
    fields.exactText,
    fields.zhText,
    fields.enText,
    fields.mixedText,
  ]
    .filter(Boolean)
    .join(" ");
  return keywordScore(haystack, extractSearchTerms(query));
}

function rankByScore(
  corpus: EvalChunk[],
  scoreOf: (chunk: EvalChunk) => number,
): string[] {
  return [...corpus]
    .map((chunk) => ({ id: chunk.id, score: scoreOf(chunk) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((row) => row.id);
}

const keywordRanker: RankFn = (query, corpus) =>
  rankByScore(corpus, (c) => scoreRaw(query, c.text));

const multilingualFieldsRanker: RankFn = (query, corpus) =>
  rankByScore(corpus, (c) => scoreMultilingualFields(query, c.text));

const multiQueryRanker: RankFn = (query, corpus) => {
  const plan = planQuery(query, { multiQuery: true, topK: 8 });
  if (plan.variants.length <= 1) {
    return multilingualFieldsRanker(query, corpus);
  }
  const lists: string[][] = [];
  const weights: number[] = [];
  for (const variant of plan.variants) {
    lists.push(multilingualFieldsRanker(variant.text, corpus));
    weights.push(variant.weight);
  }
  const fused = weightedRrfFusion(lists, weights);
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
};

const lexicalRerankRanker: RankFn = (query, corpus) => {
  const baseIds = multilingualFieldsRanker(query, corpus);
  if (baseIds.length <= 1) return baseIds;
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const hits = baseIds.map((id, index) => ({
    id,
    score: 1 / (index + 1),
    text: byId.get(id)?.text ?? "",
  }));
  const reranker = new LexicalReranker();
  const ranked = reranker.rerankWithMeta(
    query,
    hits.map((h) => ({ id: h.id, text: h.text })),
    hits.length,
  );
  if (ranked.preservedOrder) {
    return baseIds;
  }
  const boosted = applyLexicalBoost(
    hits.map((h) => ({ id: h.id, score: h.score })),
    ranked.items,
  );
  return boosted.map((row) => row.id);
};

/** 确定性词袋投影：CI 测 hybrid RRF 管线（实验/延期，非真实多语言 embedding） */
const STUB_DIM = 64;

function lexicalStubEmbed(text: string): Float32Array {
  const fields = buildMultilingualFields(text);
  const terms = [
    ...extractSearchTerms(text),
    ...fields.exactText.split(/\s+/),
    ...fields.zhText.split(/\s+/),
    ...fields.enText.split(/\s+/),
    ...fields.mixedText.split(/\s+/),
  ].filter(Boolean);
  const vec = new Float32Array(STUB_DIM);
  for (const term of terms) {
    let h = 2166136261;
    for (let i = 0; i < term.length; i += 1) {
      h ^= term.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[(h >>> 0) % STUB_DIM]! += 1;
  }
  let norm = 0;
  for (let i = 0; i < STUB_DIM; i += 1) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < STUB_DIM; i += 1) vec[i]! /= norm;
  return vec;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

const hybridRrfLexicalStubRanker: RankFn = (query, corpus) => {
  const keywordRanked = multilingualFieldsRanker(query, corpus);
  // stub 无真实跨语言几何；无关键词命中时不单独用弱 cosine 撑召回（控无答案误召回）
  if (keywordRanked.length === 0) return [];

  const queryVec = lexicalStubEmbed(query);
  const semanticRanked = [...corpus]
    .map((chunk) => ({
      id: chunk.id,
      score: cosine(queryVec, lexicalStubEmbed(chunk.text)),
    }))
    .filter((row) => row.score > 0.12)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((row) => row.id);

  const lists =
    semanticRanked.length > 0
      ? [keywordRanked, semanticRanked]
      : [keywordRanked];
  const weights = semanticRanked.length > 0 ? [1.2, 1.2] : [1.2];
  const fused = weightedRrfFusion(lists, weights);
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
};

const RANKERS: Record<RankerStrategyId, RankFn> = {
  keyword: keywordRanker,
  keyword_multilingual_fields: multilingualFieldsRanker,
  multi_query: multiQueryRanker,
  lexical_rerank: lexicalRerankRanker,
  hybrid_rrf_lexical_stub: hybridRrfLexicalStubRanker,
};

export function getRanker(strategy: RankerStrategyId): RankFn {
  return RANKERS[strategy];
}

export function listRankerStrategies(): RankerStrategyId[] {
  return Object.keys(RANKERS) as RankerStrategyId[];
}
