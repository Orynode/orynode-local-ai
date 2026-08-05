/**
 * 主机内存档位（平台中立纯函数）
 *
 * 与 scripts/data-service/host-memory.mjs 必须保持一致
 *（由 tests/platform/host-memory-contract.test.ts 门禁）。
 *
 * 词汇约定（勿混用）：
 * - hostMemoryClass：物理机统一内存档（low / medium / high）
 * - memoryPressure：运行时压力（normal / constrained / critical）→ 映射 resourcePressure
 * - memoryTier：知识检索执行封顶（lite / balanced / quality）← HostCapabilities
 */

export type HostMemoryClass = "low" | "medium" | "high";

export type MemoryPressure = "normal" | "constrained" | "critical";

export type KnowledgeMemoryTier = "lite" | "balanced" | "quality";

/** ≤10 GiB 视为 8GB 级产品目标机（含系统预留） */
export const HOST_MEMORY_LOW_MAX_BYTES = 10 * 1024 ** 3;
/** ≤18 GiB 视为 16GB 级 */
export const HOST_MEMORY_MEDIUM_MAX_BYTES = 18 * 1024 ** 3;

export function classifyHostMemory(totalBytes: number): HostMemoryClass {
  const bytes = Number.isFinite(totalBytes) ? Math.max(0, totalBytes) : 0;
  if (bytes > 0 && bytes <= HOST_MEMORY_LOW_MAX_BYTES) return "low";
  if (bytes > 0 && bytes <= HOST_MEMORY_MEDIUM_MAX_BYTES) return "medium";
  return "high";
}

/**
 * 推荐对话上下文上限（token）。
 * 用户仍可选手动更大值；UI / Settings 应提示低配机风险。
 */
export function recommendedMaxContext(
  hostClass: HostMemoryClass,
): 4096 | 8192 | 16384 | 32768 {
  if (hostClass === "low") return 8192;
  if (hostClass === "medium") return 16384;
  return 32768;
}

/**
 * 本机内存推荐运行时配置（首次初始化与「套用本机推荐」共用）。
 * knowledgeTier 保持 auto：由 Capability/压力管道降级，不在此写死 lite。
 */
export type MemoryRuntimePreset = {
  hostMemoryClass: HostMemoryClass;
  label: string;
  summary: string;
  settings: {
    maxContext: 4096 | 8192 | 16384 | 32768;
    knowledgeTier: "auto";
    ocrMode: "auto";
  };
};

export function hostMemoryClassLabel(hostClass: HostMemoryClass): string {
  if (hostClass === "low") return "约 8GB";
  if (hostClass === "medium") return "约 16GB";
  return "32GB+";
}

export function recommendedRuntimePreset(
  hostClass: HostMemoryClass,
): MemoryRuntimePreset {
  const maxContext = recommendedMaxContext(hostClass);
  if (hostClass === "low") {
    return {
      hostMemoryClass: hostClass,
      label: "8GB 本机推荐",
      summary: "较小上下文，优先保证对话与检索同时占得下",
      settings: {
        maxContext,
        knowledgeTier: "auto",
        ocrMode: "auto",
      },
    };
  }
  if (hostClass === "medium") {
    return {
      hostMemoryClass: hostClass,
      label: "16GB 本机推荐",
      summary: "标准上下文，空闲时可融合语义检索",
      settings: {
        maxContext,
        knowledgeTier: "auto",
        ocrMode: "auto",
      },
    };
  }
  return {
    hostMemoryClass: hostClass,
    label: "高配本机推荐",
    summary: "更大上下文窗口，适合长对话与更大资料库",
    settings: {
      maxContext,
      knowledgeTier: "auto",
      ocrMode: "auto",
    },
  };
}

/**
 * 主机可支撑的最高检索执行档（不含 auto）。
 * low：有语义 → balanced；无语义 → lite（quality 多查询在压力下另由 resourcePressure 降级）
 */
export function hostKnowledgeCeiling(
  hostClass: HostMemoryClass,
  semanticEnabled: boolean,
): KnowledgeMemoryTier {
  if (!semanticEnabled) return "lite";
  if (hostClass === "low") return "balanced";
  return "quality";
}

/**
 * 由瞬时状态合成 memoryPressure。
 * 主机档（low/medium/high）单独通过 hostKnowledgeCeiling / recommendedMaxContext 表达。
 * embedResident 仅观测（快照字段），不在此抬压——否则 e5 一旦加载，8GB 上将永远无法 hybrid 查询。
 * Chat / OCR / embedding lease 抬压 → CapabilitySnapshot.resourcePressure → 检索回退 lite。
 */
export function resolveMemoryPressure(input: {
  hostClass: HostMemoryClass;
  chatActive?: boolean;
  heavyKind?: string | null;
  embedResident?: boolean;
}): MemoryPressure {
  void input.hostClass;
  void input.embedResident;
  if (input.chatActive) return "critical";
  if (input.heavyKind === "ocr" || input.heavyKind === "embedding") {
    return "critical";
  }
  return "normal";
}

export function memoryPressureToResourcePressure(
  pressure: MemoryPressure,
): "normal" | "high" {
  return pressure === "normal" ? "normal" : "high";
}
