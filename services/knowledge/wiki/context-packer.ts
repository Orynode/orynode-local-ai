/**
 * Wiki 编译输入按 token 装箱，长文档分 batch，保留全局 [S#]。
 * Gemma 不进摄取；这里只决定一次 Job 能喂多少证据。
 */

import { estimateTokens } from "../../chat/context";
import { truncateChunkForBudget } from "../context/token-pack";
import { WIKI_MAX_SECTIONS, type WikiSection } from "./compile-document-mirror";

/** 单批证据预算：给 system / 指令 / 输出留窗 */
export const WIKI_PACK_INPUT_TOKENS = 2200;
/** 单节摘录上限（约等于旧 280 字） */
export const WIKI_PACK_EXCERPT_TOKENS = 140;
/** 8GB 机器一次 compile_wiki 最多几批 */
export const WIKI_PACK_MAX_BATCHES = 3;

export type PackedWikiSection = WikiSection & {
  /** 1-based 全局引用编号，跨 batch 稳定 */
  globalIndex: number;
};

export type WikiSectionBatch = {
  batchIndex: number;
  sections: PackedWikiSection[];
  tokenCount: number;
};

export type WikiPackResult = {
  batches: WikiSectionBatch[];
  sections: PackedWikiSection[];
  totalSections: number;
  dropped: number;
  tokenCount: number;
};

export function packWikiSections(
  sections: WikiSection[],
  options?: {
    inputBudgetTokens?: number;
    excerptMaxTokens?: number;
    maxSections?: number;
    maxBatches?: number;
  },
): WikiPackResult {
  const maxSections = Math.max(
    1,
    Math.min(options?.maxSections ?? WIKI_MAX_SECTIONS, WIKI_MAX_SECTIONS),
  );
  const excerptMaxTokens = Math.max(
    24,
    options?.excerptMaxTokens ?? WIKI_PACK_EXCERPT_TOKENS,
  );
  const inputBudget = Math.max(
    256,
    options?.inputBudgetTokens ?? WIKI_PACK_INPUT_TOKENS,
  );
  const maxBatches = Math.max(
    1,
    Math.min(options?.maxBatches ?? WIKI_PACK_MAX_BATCHES, 8),
  );

  const packed: PackedWikiSection[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    if (packed.length >= maxSections) break;
    const section = sections[index]!;
    const excerpt = truncateChunkForBudget(
      String(section.excerpt || "").replace(/\s+/g, " ").trim(),
      excerptMaxTokens,
    ).text.trim();
    if (!excerpt) continue;
    packed.push({
      ...section,
      excerpt,
      globalIndex: index + 1,
    });
  }

  const batches: WikiSectionBatch[] = [];
  let current: PackedWikiSection[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    batches.push({
      batchIndex: batches.length,
      sections: current,
      tokenCount: currentTokens,
    });
    current = [];
    currentTokens = 0;
  };

  for (const section of packed) {
    if (batches.length >= maxBatches) break;
    const cost = estimatePackedSectionTokens(section);
    const wouldOverflow =
      current.length > 0 && currentTokens + cost > inputBudget;
    if (wouldOverflow) {
      flush();
      if (batches.length >= maxBatches) break;
    }
    if (current.length === 0 && cost > inputBudget) {
      current = [section];
      currentTokens = cost;
      flush();
      continue;
    }
    current.push(section);
    currentTokens += cost;
  }
  if (batches.length < maxBatches) flush();

  const included = batches.reduce((sum, batch) => sum + batch.sections.length, 0);
  return {
    batches,
    sections: packed.slice(0, included),
    totalSections: packed.length,
    dropped: packed.length - included,
    tokenCount: batches.reduce((sum, batch) => sum + batch.tokenCount, 0),
  };
}

function estimatePackedSectionTokens(section: PackedWikiSection): number {
  const source = section.sourceDocumentTitle
    ? `（来自《${section.sourceDocumentTitle}》）`
    : "";
  return estimateTokens(
    `[S${section.globalIndex}] ${section.heading}${source}\n${section.excerpt}`,
  );
}
