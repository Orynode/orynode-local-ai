/**
 * blob_scan 工作集收窄：有关键词命中时，向量只扫命中文档，避免 library-all 全表进堆。
 */

import type { RetrievalScope } from "../types";

export type VectorScanPlan = {
  scope: Exclude<RetrievalScope, { mode: "none" }>;
  /** 传给 VectorIndex / data-service 的文档收窄；空表示不额外收窄 */
  documentIds?: string[];
  narrowed: boolean;
};

/**
 * 关键词已命中文档时，将向量扫描收窄到这些 documentId（仍受原 scope 约束）。
 * 无命中时保持原 scope，以支持纯向量兜底。
 */
export function planVectorScanScope(
  scope: Exclude<RetrievalScope, { mode: "none" }>,
  keywordDocumentIds: Iterable<string>,
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

  return {
    scope: {
      ...scope,
      library: { documentIds: narrowedIds },
    },
    documentIds: narrowedIds,
    narrowed: true,
  };
}
