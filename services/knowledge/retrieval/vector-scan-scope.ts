/**
 * blob_scan 工作集收窄：关键词命中足够强时，向量只扫命中文档，
 * 避免 library-all 全表进堆；弱命中保持原 scope，
 * 语义相关但词法零重叠的文档不被排除（成本由 maxVectorScanChunks 兜底）。
 */

import { SEARCH_CONFIG } from "../../../config/defaults";
import type { RetrievalScope } from "../types";

export type VectorScanPlan = {
  scope: Exclude<RetrievalScope, { mode: "none" }>;
  /** 传给 VectorIndex / data-service 的文档收窄；空表示不额外收窄 */
  documentIds?: string[];
  narrowed: boolean;
};

export type VectorScanStrength = {
  /** 关键词命中仅来自 minimum_match 宽松步骤（强度减半，门槛翻倍） */
  minimumMatchOnly?: boolean;
  /** 覆盖默认收窄门槛（测试/调优用） */
  minDocs?: number;
};

/**
 * 按命中强度决定是否收窄：
 * - 0 命中：保持原 scope，支持纯向量兜底。
 * - 命中文档数 < 门槛（默认 3；minimum_match 命中翻倍为 6）：
 *   弱命中不收窄，避免排除语义相关但词法零重叠的文档。
 * - 命中足够强：收窄到命中文档（仍与原 scope 求交）。
 */
export function planVectorScanScope(
  scope: Exclude<RetrievalScope, { mode: "none" }>,
  keywordDocumentIds: Iterable<string>,
  strength: VectorScanStrength = {},
): VectorScanPlan {
  const hitIds = [
    ...new Set(
      [...keywordDocumentIds].filter((id) => typeof id === "string" && id),
    ),
  ];
  if (hitIds.length === 0) {
    return { scope, narrowed: false };
  }

  const allowed =
    scope.library && scope.library !== "all" && Array.isArray(scope.library.documentIds)
      ? new Set(scope.library.documentIds)
      : null;
  const narrowedIds = allowed
    ? hitIds.filter((id) => allowed.has(id))
    : hitIds;
  if (narrowedIds.length === 0) {
    return { scope, narrowed: false };
  }

  const base =
    typeof strength.minDocs === "number" && strength.minDocs >= 1
      ? Math.floor(strength.minDocs)
      : SEARCH_CONFIG.vectorScanNarrowMinDocs;
  const threshold = strength.minimumMatchOnly ? base * 2 : base;
  if (narrowedIds.length < threshold) {
    return { scope, narrowed: false };
  }

  return {
    scope: {
      ...scope,
      library: { documentIds: narrowedIds },
    },
    documentIds: narrowedIds,
    narrowed: true,
  };
}
