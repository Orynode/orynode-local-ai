/**
 * 知识能力探测（供 UI / Agent / 检索档位降级）
 */

import {
  ORYNODE_DATA_URL,
  HTTP_TIMEOUT,
  SEARCH_CONFIG,
  EMBEDDING_CONFIG,
  tierRequestsEmbedding,
  parseKnowledgeTier,
  type KnowledgeTier,
  type OcrMode,
} from "../../../config/defaults";
import type { HostCapabilities, OcrCapability } from "../../platform/types";
import { createRuntimeServices } from "../../platform/composition-root";
import {
  classifyHostMemory,
  hostKnowledgeCeiling,
} from "../../platform/host-memory";
import { totalmem } from "node:os";
import type {
  CapabilitySnapshot,
  EffectiveKnowledgeTier,
  RerankerCapabilityType,
} from "../retrieval/profile";
import { isUsableLibraryDocument } from "../status";

export type KnowledgeOcrCapability = {
  available: boolean;
  engine: string | null;
  engineVersion: string | null;
  mode: OcrMode;
  boundingBoxes: boolean;
  degradedReason: string | null;
  languages?: string[];
  /**
   * Windows KE-034 等：契约/artifact 已预留、实现未落地。
   * available 仍为 false，reason 为 OCR_UNAVAILABLE。
   */
  reservation?: "planned" | null;
};

export type KnowledgeSearchCapability = {
  requestedTier: KnowledgeTier;
  effectiveTier: EffectiveKnowledgeTier;
  keyword: { available: boolean };
  semantic: {
    enabled: boolean;
    runtimeReady: boolean;
    indexedDocuments: number;
    totalDocuments: number;
  };
  reranker: {
    available: boolean;
    type: RerankerCapabilityType | null;
  };
  degradedReasons: string[];
};

export type KnowledgeCapabilities = HostCapabilities & {
  requestedTier: KnowledgeTier;
  effectiveTier: EffectiveKnowledgeTier;
  degradedCapabilities: string[];
  degradedReasons: string[];
  /** 主机是否加载向量模型（ORYNODE_SEMANTIC_SEARCH） */
  semanticSearchEnabled: boolean;
  /** 当前档位是否请求语义（仍取决于 semanticSearchEnabled） */
  tierRequestsEmbedding: boolean;
  /** §16.11 OCR 能力对象；顶层 ocr boolean 由其派生 */
  ocrDetail: KnowledgeOcrCapability;
  /** 普通用户 / 诊断用嵌套能力（方案 §9） */
  knowledgeSearch: KnowledgeSearchCapability;
  /** 向量补建进度；null 表示未开启语义或探测失败 */
  vectorCoverage: {
    indexedDocuments: number;
    totalDocuments: number;
    pendingDocuments: number;
    vectorIndexReady: boolean;
  } | null;
  /** 本地重排真实类型 */
  rerankerType: RerankerCapabilityType | null;
  resourcePressure: "normal" | "high";
};

export type VectorCoverage = {
  indexedDocuments: number;
  totalDocuments: number;
  pendingDocuments: number;
  vectorIndexReady: boolean;
};

async function probeEmbedding(): Promise<boolean> {
  if (!SEARCH_CONFIG.semanticSearchEnabled) return false;
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/knowledge/embed/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.embeddingStatus),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      available?: boolean;
      ready?: boolean;
      enabled?: boolean;
    };
    // data-service 返回 available；兼容旧 ready/enabled
    return Boolean(body.available ?? body.ready ?? body.enabled);
  } catch {
    return false;
  }
}

async function probeFts(): Promise<string | null> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/retrieval/keyword/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "探测",
        library: { mode: "all" },
        topK: 1,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { strategy?: string };
    if (body.strategy === "fts_unavailable") return null;
    if (body.strategy === "fts5_v2") return "fts5-multilingual-v1";
    return "fts5+bigram";
  } catch {
    return null;
  }
}

export async function probeVectorCoverage(): Promise<VectorCoverage> {
  try {
    const response = await fetch(
      `${ORYNODE_DATA_URL}/knowledge/vector-coverage`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
      },
    );
    if (response.ok) {
      const body = (await response.json()) as Partial<VectorCoverage>;
      const total = Number(body.totalDocuments ?? 0);
      const indexed = Number(body.indexedDocuments ?? 0);
      return {
        totalDocuments: total,
        indexedDocuments: indexed,
        pendingDocuments: Number(body.pendingDocuments ?? Math.max(0, total - indexed)),
        vectorIndexReady: Boolean(
          body.vectorIndexReady ?? (total === 0 || indexed > 0),
        ),
      };
    }
  } catch {
    // fall through：用资料库列表估算
  }

  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/knowledge`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    if (!response.ok) {
      return {
        totalDocuments: 0,
        indexedDocuments: 0,
        pendingDocuments: 0,
        vectorIndexReady: true,
      };
    }
    const body = (await response.json()) as {
      documents?: Array<{ status?: string; chunkCount?: number }>;
    };
    const searchable = (body.documents ?? []).filter(isUsableLibraryDocument);
    const indexed = searchable.filter((doc) => doc.status === "indexed");
    const total = searchable.length;
    return {
      totalDocuments: total,
      indexedDocuments: indexed.length,
      pendingDocuments: Math.max(0, total - indexed.length),
      vectorIndexReady: total === 0 || indexed.length > 0,
    };
  } catch {
    return {
      totalDocuments: 0,
      indexedDocuments: 0,
      pendingDocuments: 0,
      vectorIndexReady: true,
    };
  }
}

async function probeResourcePressure(): Promise<"normal" | "high"> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/resources`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
    });
    if (!response.ok) return "normal";
    const body = (await response.json()) as {
      chatActive?: boolean;
      heavyKind?: string | null;
      resourcePressure?: "normal" | "high";
      memoryPressure?: "normal" | "constrained" | "critical";
    };
    if (body.resourcePressure === "high" || body.resourcePressure === "normal") {
      return body.resourcePressure;
    }
    // 兼容旧字段
    if (body.chatActive) return "high";
    if (body.heavyKind === "embedding" || body.heavyKind === "ocr") {
      return "high";
    }
    if (
      body.memoryPressure === "constrained" ||
      body.memoryPressure === "critical"
    ) {
      return "high";
    }
    return "normal";
  } catch {
    return "normal";
  }
}

function memoryTierFromHost(
  embedding: boolean,
  hostCeiling: EffectiveKnowledgeTier,
): EffectiveKnowledgeTier {
  if (process.env.ORYNODE_KNOWLEDGE_TIER === "quality") return "quality";
  if (process.env.ORYNODE_KNOWLEDGE_TIER === "balanced") return "balanced";
  if (process.env.ORYNODE_KNOWLEDGE_TIER === "lite") return "lite";
  // 环境未强制时：取「有语义时可走的档」与主机封顶的较低者
  const fromEmbed: EffectiveKnowledgeTier = embedding ? "quality" : "lite";
  const order: EffectiveKnowledgeTier[] = ["lite", "balanced", "quality"];
  return order[
    Math.min(order.indexOf(fromEmbed), order.indexOf(hostCeiling))
  ]!;
}

export async function probeCapabilitySnapshot(): Promise<CapabilitySnapshot> {
  const [embedding, ftsTokenizer, coverage, resourcePressure] =
    await Promise.all([
      probeEmbedding(),
      probeFts(),
      probeVectorCoverage(),
      probeResourcePressure(),
    ]);
  const role = EMBEDDING_CONFIG.role;
  // role===default 表示当前推荐的多语言 artifact（如 multilingual-e5-small）
  const wantsMultilingualDefault = role === "default";
  const hostClass = classifyHostMemory(totalmem());
  const hostCeiling = hostKnowledgeCeiling(hostClass, embedding);
  return {
    embedding,
    vectorIndexReady: embedding ? coverage.vectorIndexReady : false,
    // 本地 LexicalReranker 始终可用；非独立语义 Reranker 模型
    reranker: true,
    rerankerType: "lexical",
    ftsTokenizer,
    memoryTier: memoryTierFromHost(embedding, hostCeiling),
    externalConnectors: { web: true, github: true },
    resourcePressure,
    embeddingArtifactId: EMBEDDING_CONFIG.artifactId,
    embeddingArtifactRole: role,
    multilingualVectorUnavailable: wantsMultilingualDefault && !embedding,
  };
}

async function readOcrModeSetting(): Promise<OcrMode> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/settings`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.settings),
    });
    if (!response.ok) return "auto";
    const body = (await response.json()) as {
      settings?: { ocrMode?: string };
    };
    return body.settings?.ocrMode === "disabled" ? "disabled" : "auto";
  } catch {
    return "auto";
  }
}

async function resolveOcrDetail(
  mode: OcrMode,
): Promise<{ host: HostCapabilities; detail: KnowledgeOcrCapability }> {
  const runtime = createRuntimeServices();
  const host = await runtime.host.capabilities();
  let engineCap: OcrCapability | null = null;
  if (runtime.ocr) {
    try {
      engineCap = await runtime.ocr.capabilities();
    } catch {
      engineCap = null;
    }
  }

  const available = Boolean(engineCap?.available ?? host.ocr);
  const windowsReserved =
    host.platform === "windows" &&
    !available &&
    (engineCap?.engine === "pp-ocr-v5-mobile-onnx" ||
      engineCap?.reason === "OCR_UNAVAILABLE");

  let degradedReason: string | null = null;
  if (!available) {
    degradedReason = engineCap?.reason || "OCR_UNAVAILABLE";
  } else if (mode === "disabled") {
    degradedReason = "OCR_DISABLED";
  }

  const detail: KnowledgeOcrCapability = {
    available: available && mode !== "disabled",
    engine: engineCap?.engine ?? null,
    engineVersion: engineCap?.engineVersion ?? null,
    mode,
    boundingBoxes: Boolean(engineCap?.boundingBoxes),
    degradedReason,
    languages: engineCap?.languages,
    reservation: windowsReserved ? "planned" : null,
  };

  return {
    host: {
      ...host,
      ocr: detail.available,
      ftsTokenizer: host.ftsTokenizer,
    },
    detail,
  };
}

export async function getKnowledgeCapabilities(
  requestedTier: KnowledgeTier = "auto",
): Promise<KnowledgeCapabilities> {
  const [snap, ocrMode, coverage] = await Promise.all([
    probeCapabilitySnapshot(),
    readOcrModeSetting(),
    probeVectorCoverage(),
  ]);
  const { resolveRetrievalProfile } = await import("../retrieval/profile");
  const profile = resolveRetrievalProfile(requestedTier, snap);
  const { host, detail } = await resolveOcrDetail(ocrMode);

  // 语义就绪时后台补建（节流）；失败不影响能力返回
  if (SEARCH_CONFIG.semanticSearchEnabled && snap.embedding) {
    void import("../indexer")
      .then((mod) => mod.ensurePendingVectorBackfill())
      .catch(() => undefined);
  }

  const knowledgeSearch: KnowledgeSearchCapability = {
    requestedTier: profile.requestedTier,
    effectiveTier: profile.effectiveTier,
    keyword: { available: Boolean(snap.ftsTokenizer) },
    semantic: {
      enabled: SEARCH_CONFIG.semanticSearchEnabled,
      runtimeReady: snap.embedding,
      indexedDocuments: coverage.indexedDocuments,
      totalDocuments: coverage.totalDocuments,
    },
    reranker: {
      available: snap.reranker,
      type: snap.rerankerType ?? (snap.reranker ? "lexical" : null),
    },
    degradedReasons: profile.degradedReasons,
  };

  return {
    platform: host.platform,
    modelRuntime: host.modelRuntime,
    embedding: snap.embedding,
    reranker: snap.reranker,
    rerankerType: snap.rerankerType ?? (snap.reranker ? "lexical" : null),
    ocr: detail.available,
    ocrDetail: detail,
    ftsTokenizer: snap.ftsTokenizer ?? host.ftsTokenizer,
    memoryTier: snap.memoryTier,
    externalConnectors: snap.externalConnectors,
    requestedTier: profile.requestedTier,
    effectiveTier: profile.effectiveTier,
    degradedCapabilities: profile.degradedReasons,
    degradedReasons: profile.degradedReasons,
    semanticSearchEnabled: SEARCH_CONFIG.semanticSearchEnabled,
    tierRequestsEmbedding: tierRequestsEmbedding(requestedTier),
    knowledgeSearch,
    vectorCoverage: coverage,
    resourcePressure: snap.resourcePressure ?? "normal",
  };
}

export async function readKnowledgeTierSetting(): Promise<KnowledgeTier> {
  try {
    const response = await fetch(`${ORYNODE_DATA_URL}/settings`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.settings),
    });
    if (!response.ok) return "auto";
    const body = (await response.json()) as {
      settings?: { knowledgeTier?: string };
    };
    const tier = parseKnowledgeTier(body.settings?.knowledgeTier);
    if (tier) return tier;
  } catch {
    // ignore
  }
  return "auto";
}
