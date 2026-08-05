/**
 * 主机内存档位（与 services/platform/host-memory.ts 对齐）
 *
 * 必须与 TS 源保持一致（tests/platform/host-memory-contract.test.ts 门禁）。
 *
 * 词汇约定（勿混用）：
 * - hostMemoryClass：物理机统一内存档（low / medium / high）
 * - memoryPressure：运行时压力（normal / constrained / critical）→ 映射 resourcePressure
 * - memoryTier：知识检索执行封顶（lite / balanced / quality）← HostCapabilities
 */

/** ≤10 GiB 视为 8GB 级产品目标机（含系统预留） */
export const HOST_MEMORY_LOW_MAX_BYTES = 10 * 1024 ** 3;
/** ≤18 GiB 视为 16GB 级 */
export const HOST_MEMORY_MEDIUM_MAX_BYTES = 18 * 1024 ** 3;

/**
 * @param {number} totalBytes
 * @returns {"low" | "medium" | "high"}
 */
export function classifyHostMemory(totalBytes) {
  const bytes = Number.isFinite(totalBytes) ? Math.max(0, totalBytes) : 0;
  if (bytes > 0 && bytes <= HOST_MEMORY_LOW_MAX_BYTES) return "low";
  if (bytes > 0 && bytes <= HOST_MEMORY_MEDIUM_MAX_BYTES) return "medium";
  return "high";
}

/**
 * @param {"low" | "medium" | "high"} hostClass
 * @returns {4096 | 8192 | 16384 | 32768}
 */
export function recommendedMaxContext(hostClass) {
  if (hostClass === "low") return 8192;
  if (hostClass === "medium") return 16384;
  return 32768;
}

/**
 * @param {"low" | "medium" | "high"} hostClass
 * @returns {string}
 */
export function hostMemoryClassLabel(hostClass) {
  if (hostClass === "low") return "约 8GB";
  if (hostClass === "medium") return "约 16GB";
  return "32GB+";
}

/**
 * 本机内存推荐运行时配置（首次初始化与「套用本机推荐」共用）。
 * @param {"low" | "medium" | "high"} hostClass
 */
export function recommendedRuntimePreset(hostClass) {
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
 * @param {"low" | "medium" | "high"} hostClass
 * @param {boolean} semanticEnabled
 * @returns {"lite" | "balanced" | "quality"}
 */
export function hostKnowledgeCeiling(hostClass, semanticEnabled) {
  if (!semanticEnabled) return "lite";
  if (hostClass === "low") return "balanced";
  return "quality";
}

/**
 * 由瞬时状态合成 memoryPressure。
 * 主机档单独通过 ceiling / recommendedMaxContext 表达。
 * embedResident 仅观测，不在此抬压（避免 e5 加载后 8GB 永久无法 hybrid）。
 *
 * @param {{
 *   hostClass: "low" | "medium" | "high",
 *   chatActive?: boolean,
 *   heavyKind?: string | null,
 *   embedResident?: boolean,
 * }} input
 * @returns {"normal" | "constrained" | "critical"}
 */
export function resolveMemoryPressure(input) {
  if (input.chatActive) return "critical";
  if (input.heavyKind === "ocr" || input.heavyKind === "embedding") {
    return "critical";
  }
  return "normal";
}

/**
 * @param {"normal" | "constrained" | "critical"} pressure
 * @returns {"normal" | "high"}
 */
export function memoryPressureToResourcePressure(pressure) {
  return pressure === "normal" ? "normal" : "high";
}
