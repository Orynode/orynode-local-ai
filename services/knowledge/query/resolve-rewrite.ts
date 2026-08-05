/**
 * 可学习 Query Rewrite（唯一开放世界同义入口）：
 * 术语库命中 → 跳过 LLM；未命中 → LLM → 写入术语库 → 检索。
 */

import { QUERY_REWRITE_LLM_ENABLED } from "../../../config/defaults";
import { isChatResourceActive } from "../resource";
import { shouldExpandQuery } from "../retrieval/query-type";
import { rewriteQueryWithLlm } from "./llm-rewrite";
import {
  listLearnedTerminology,
  recordTerminologyHit,
  upsertLearnedTerminology,
} from "./terminology-client";
import { BUILTIN_TERMINOLOGY, type TerminologyEntry } from "./terminology";
import {
  EMPTY_REWRITE,
  filterSynonymsByQueryLanguage,
  rewriteFromEntries,
} from "./terminology-match";
import type { StructuredQueryRewrite } from "./query-rewrite";

export type ResolveRewriteOptions = {
  skipLlm?: boolean;
  llmRewrite?: typeof rewriteQueryWithLlm;
  learnedEntries?: TerminologyEntry[];
};

/**
 * 解析改写：术语库优先，未命中再 LLM 并晋升。
 */
export async function resolveQueryRewrite(
  query: string,
  options: ResolveRewriteOptions = {},
): Promise<StructuredQueryRewrite> {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (!trimmed || !shouldExpandQuery(trimmed)) {
    return { ...EMPTY_REWRITE };
  }

  const learned =
    options.learnedEntries ?? (await listLearnedTerminology());
  // learned 优先扫描；BUILTIN 仅冷启动种子
  const catalog: TerminologyEntry[] = [...learned, ...BUILTIN_TERMINOLOGY];

  const fromStore = rewriteFromEntries(trimmed, catalog, "terminology");
  if (fromStore.source === "terminology") {
    for (const id of fromStore.matchedEntryIds) {
      if (learned.some((e) => e.id === id)) void recordTerminologyHit(id);
    }
    return fromStore;
  }

  if (options.skipLlm || !QUERY_REWRITE_LLM_ENABLED) {
    return fromStore;
  }

  if (await isChatResourceActive()) {
    return { ...EMPTY_REWRITE };
  }

  const llm = options.llmRewrite ?? rewriteQueryWithLlm;
  const payload = await llm(trimmed);
  if (!payload) return fromStore;

  // 本轮检索：按查询语言过滤同义（跨语言）
  const synonyms = filterSynonymsByQueryLanguage(payload.synonyms, trimmed).filter(
    (s) => s.toLocaleLowerCase() !== trimmed.toLocaleLowerCase(),
  );
  const exclude = payload.exclude.filter(
    (s) => s.toLocaleLowerCase() !== trimmed.toLocaleLowerCase(),
  );

  // 无同义则不晋升（exclude-only 不够建条目）
  if (synonyms.length === 0 && payload.synonyms.length === 0) {
    return {
      source: "llm",
      domain: payload.domain,
      synonyms: [],
      exclude,
      matchedEntryIds: [],
    };
  }

  // 入库保留多语言全量同义；语言过滤只作用于本轮 variant
  const storeTerms = [
    ...new Set(
      [trimmed, ...payload.synonyms]
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];

  const saved = await upsertLearnedTerminology({
    domain: payload.domain,
    terms: storeTerms,
    exclude,
    source: "learned",
  });

  return {
    source: "llm",
    domain: payload.domain,
    synonyms,
    exclude,
    matchedEntryIds: saved?.id ? [saved.id] : [],
  };
}
