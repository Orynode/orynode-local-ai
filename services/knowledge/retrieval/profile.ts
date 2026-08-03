/**
 * 检索档位 → 策略开关（Capability 可降级）
 *
 * requestedTier：用户请求（含 auto）
 * effectiveTier：本次实际执行（仅 lite | balanced | quality）
 */

import type { KnowledgeTier } from "../../../config/defaults";
import { SEARCH_CONFIG } from "../../../config/defaults";

export type EffectiveKnowledgeTier = "lite" | "balanced" | "quality";

export type RerankerCapabilityType = "lexical" | "semantic";

export type RetrievalProfile = {
  /** @deprecated 使用 effectiveTier；保留兼容 */
  tier: EffectiveKnowledgeTier;
  requestedTier: KnowledgeTier;
  effectiveTier: EffectiveKnowledgeTier;
  keyword: true;
  embedding: boolean;
  multiQuery: boolean;
  rerank: boolean;
  topK: number;
  /** 稳定降级原因码（对外 diagnostics） */
  degradedReasons: string[];
  /** @deprecated 同 degradedReasons；保留兼容 */
  degraded: string[];
};

export type CapabilitySnapshot = {
  /** Embedding Runtime 已就绪 */
  embedding: boolean;
  /**
   * 当前库是否已有可用向量索引。
   * undefined：兼容旧调用，视为与 embedding 相同（不单独因索引降级）。
   * false：有可检索文档但尚无向量 → Auto/Balanced 降级 Lite。
   */
  vectorIndexReady?: boolean;
  /** 是否有可用本地重排（含 lexical） */
  reranker: boolean;
  /** 重排真实类型；无独立语义模型时为 lexical */
  rerankerType?: RerankerCapabilityType | null;
  ftsTokenizer: string | null;
  /** 主机可支撑的最高执行档位（不含 auto） */
  memoryTier: EffectiveKnowledgeTier;
  externalConnectors: { web: boolean; github: boolean };
  resourcePressure?: "normal" | "high";
  /** 当前选中的 embedding artifact id */
  embeddingArtifactId?: string | null;
  /** default | compat_baseline | experimental；baseline/multilingual 为遗留读取兼容 */
  embeddingArtifactRole?:
    | "default"
    | "compat_baseline"
    | "experimental"
    | "baseline"
    | "multilingual"
    | null;
  /** 请求了 multilingual 但 runtime/索引不可用 */
  multilingualVectorUnavailable?: boolean;
};

const EXEC_ORDER: EffectiveKnowledgeTier[] = ["lite", "balanced", "quality"];

function semanticUnavailableReason(caps: CapabilitySnapshot): string {
  // 优先报告更具体的索引缺口（即使 env 未开语义，测试也可注入 embedding:true）
  if (caps.embedding && caps.vectorIndexReady === false) {
    return "VECTOR_INDEX_NOT_READY";
  }
  if (!SEARCH_CONFIG.semanticSearchEnabled) {
    return "SEMANTIC_SEARCH_DISABLED";
  }
  if (!caps.embedding) {
    return "SEMANTIC_RUNTIME_UNAVAILABLE";
  }
  if (caps.vectorIndexReady === false) {
    return "VECTOR_INDEX_NOT_READY";
  }
  return "SEMANTIC_RUNTIME_UNAVAILABLE";
}

function isSemanticReady(caps: CapabilitySnapshot): boolean {
  if (!caps.embedding) return false;
  // 未显式探测索引时，不因缺失字段单独否决（测试 / 旧路径）
  if (caps.vectorIndexReady === false) return false;
  return true;
}

function capEffectiveTier(
  tier: EffectiveKnowledgeTier,
  memoryTier: EffectiveKnowledgeTier,
  reasons: string[],
): EffectiveKnowledgeTier {
  if (EXEC_ORDER.indexOf(tier) > EXEC_ORDER.indexOf(memoryTier)) {
    reasons.push("QUALITY_RETRIEVAL_UNAVAILABLE");
    return memoryTier;
  }
  return tier;
}

/**
 * 将用户请求档位解析为实际执行档位（单一入口，UI/Chat/Agent/检索共用）。
 */
export function resolveKnowledgeTier(
  requested: KnowledgeTier,
  caps: CapabilitySnapshot,
): {
  requestedTier: KnowledgeTier;
  effectiveTier: EffectiveKnowledgeTier;
  degradedReasons: string[];
} {
  const semanticReady = isSemanticReady(caps);
  const pressure = caps.resourcePressure ?? "normal";
  const degradedReasons: string[] = [];
  let effective: EffectiveKnowledgeTier;

  if (requested === "lite") {
    effective = "lite";
  } else if (requested === "auto" || requested === "balanced") {
    if (semanticReady) {
      effective = "balanced";
    } else {
      effective = "lite";
      degradedReasons.push(semanticUnavailableReason(caps));
    }
  } else {
    // quality / 更高质量
    if (!semanticReady) {
      effective = "lite";
      degradedReasons.push(semanticUnavailableReason(caps));
    } else if (pressure === "high") {
      effective = "balanced";
      degradedReasons.push("RESOURCE_PRESSURE");
      degradedReasons.push("QUALITY_RETRIEVAL_UNAVAILABLE");
    } else if (!caps.reranker) {
      effective = "balanced";
      degradedReasons.push("RERANKER_UNAVAILABLE");
      degradedReasons.push("QUALITY_RETRIEVAL_UNAVAILABLE");
    } else {
      effective = "quality";
    }
  }

  effective = capEffectiveTier(effective, caps.memoryTier, degradedReasons);

  return {
    requestedTier: requested,
    effectiveTier: effective,
    degradedReasons: [...new Set(degradedReasons)],
  };
}

export function resolveRetrievalProfile(
  requested: KnowledgeTier,
  caps: CapabilitySnapshot,
  options: { topK?: number } = {},
): RetrievalProfile {
  const resolved = resolveKnowledgeTier(requested, caps);
  const tier = resolved.effectiveTier;
  const degradedReasons = [...resolved.degradedReasons];

  const embedding = tier === "balanced" || tier === "quality";
  const multiQuery = tier === "quality";
  const rerank = tier === "quality" && caps.reranker;

  if (embedding && caps.multilingualVectorUnavailable) {
    degradedReasons.push("MULTILINGUAL_VECTOR_UNAVAILABLE");
  }

  return {
    tier,
    requestedTier: resolved.requestedTier,
    effectiveTier: tier,
    keyword: true,
    embedding,
    multiQuery,
    rerank,
    topK: options.topK ?? SEARCH_CONFIG.topK,
    degradedReasons,
    degraded: degradedReasons,
  };
}

/** 将内部 strategy 标签规范为对外 diagnostics 策略名 */
export function normalizeDiagnosticStrategies(
  strategies: Iterable<string>,
  profile: Pick<RetrievalProfile, "embedding" | "multiQuery" | "rerank">,
): string[] {
  const out = new Set<string>();
  out.add("keyword");
  for (const raw of strategies) {
    if (raw === "hybrid" || raw === "vector") {
      out.add("vector");
      out.add("rrf");
    } else if (raw === "multi_query_rrf") {
      out.add("rrf");
    } else if (raw === "lexical_rerank" || raw === "rerank") {
      out.add("lexical_rerank");
    } else if (raw === "keyword" || raw === "fts5") {
      out.add("keyword");
    }
  }
  if (profile.embedding) {
    out.add("vector");
    out.add("rrf");
  }
  if (profile.multiQuery) out.add("rrf");
  if (profile.rerank) out.add("lexical_rerank");
  return [...out];
}
