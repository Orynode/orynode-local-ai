/**
 * Embedding artifact registry（ML-008 / ML-P2）
 *
 * 运行时只加载一个 active artifact，禁止多模型混用向量空间。
 * 面向用户默认推荐 multilingual-e5-small；bge-small-zh 仅兼容/回滚/评测基线。
 */

export type EmbeddingArtifactRole =
  | "default"
  | "compat_baseline"
  | "experimental";

export interface EmbeddingArtifact {
  id: string;
  /** HuggingFace / Xenova 模型 id */
  xenovaModelId: string;
  revision: string;
  dimension: number;
  pooling: "mean";
  normalization: boolean;
  /** null：不加前缀；含 `{text}` 占位 */
  queryTemplate: string | null;
  passageTemplate: string | null;
  maxInputChars: number;
  role: EmbeddingArtifactRole;
  batchSize: number;
  notes?: string;
}

/**
 * 已登记候选。
 * - default：新安装 / 中英资料库推荐
 * - compat_baseline：旧索引兼容、中文回归对照、迁移回滚
 * - experimental：质量上限参考，非默认
 */
export const EMBEDDING_ARTIFACTS: readonly EmbeddingArtifact[] = [
  {
    id: "multilingual-e5-small",
    xenovaModelId: "Xenova/multilingual-e5-small",
    revision: "main",
    dimension: 384,
    pooling: "mean",
    normalization: true,
    queryTemplate: "query: {text}",
    passageTemplate: "passage: {text}",
    maxInputChars: 8000,
    role: "default",
    batchSize: 8,
    notes:
      "中英资料库默认推荐；查询用 query:、文档用 passage:；切换后必须重建 Vector IndexBuild",
  },
  {
    id: "bge-small-zh-v1.5",
    xenovaModelId: "Xenova/bge-small-zh-v1.5",
    revision: "main",
    dimension: 512,
    pooling: "mean",
    normalization: true,
    queryTemplate: null,
    passageTemplate: null,
    maxInputChars: 8000,
    role: "compat_baseline",
    batchSize: 8,
    notes:
      "旧版兼容与中文对照基线；非稳定跨语言空间；勿与 E5 向量混用",
  },
  {
    id: "bge-m3",
    xenovaModelId: "Xenova/bge-m3",
    revision: "main",
    dimension: 1024,
    pooling: "mean",
    normalization: true,
    queryTemplate: null,
    passageTemplate: null,
    maxInputChars: 8000,
    role: "experimental",
    batchSize: 4,
    notes: "质量上限参考；内存开销大，不作为默认",
  },
] as const;

/** 新安装 / 未设置 env 时的默认推荐 */
export const DEFAULT_EMBEDDING_ARTIFACT_ID = "multilingual-e5-small";

/** 旧索引兼容与评测对照（非新安装默认） */
export const COMPAT_BASELINE_ARTIFACT_ID = "bge-small-zh-v1.5";

export function listEmbeddingArtifacts(): EmbeddingArtifact[] {
  return [...EMBEDDING_ARTIFACTS];
}

export function getEmbeddingArtifact(
  id: string,
): EmbeddingArtifact | undefined {
  return EMBEDDING_ARTIFACTS.find((a) => a.id === id);
}

export function getRecommendedEmbeddingArtifact(): EmbeddingArtifact {
  return getEmbeddingArtifact(DEFAULT_EMBEDDING_ARTIFACT_ID)!;
}

/**
 * 解析当前 artifact：ORYNODE_EMBEDDING_ARTIFACT → 默认推荐。
 * 未知 id 回落到默认推荐（不是 compat baseline）。
 */
export function resolveEmbeddingArtifact(
  requestedId: string | undefined | null = process.env.ORYNODE_EMBEDDING_ARTIFACT,
): {
  artifact: EmbeddingArtifact;
  requestedId: string;
  fallback: boolean;
} {
  const requested =
    typeof requestedId === "string" && requestedId.trim()
      ? requestedId.trim()
      : DEFAULT_EMBEDDING_ARTIFACT_ID;
  const found = getEmbeddingArtifact(requested);
  if (found) {
    return { artifact: found, requestedId: requested, fallback: false };
  }
  const recommended = getRecommendedEmbeddingArtifact();
  return {
    artifact: recommended,
    requestedId: requested,
    fallback: true,
  };
}

export function applyEmbeddingTemplate(
  template: string | null | undefined,
  text: string,
): string {
  const raw = String(text ?? "");
  if (!template) return raw;
  return template.replaceAll("{text}", raw);
}

/** IndexBuild.configHash 覆盖字段（ADR-ML-004 / §7.2） */
export function embeddingConfigFingerprint(artifact: EmbeddingArtifact): string {
  return [
    artifact.id,
    artifact.revision,
    String(artifact.dimension),
    artifact.pooling,
    artifact.normalization ? "1" : "0",
    artifact.queryTemplate ?? "",
    artifact.passageTemplate ?? "",
    String(artifact.maxInputChars),
  ].join("|");
}

/**
 * 查询侧向量是否可与某 IndexBuild 混用。
 * 模型 id 或维度不一致时必须拒绝（不可只改 env 继续用旧向量）。
 */
export function isEmbeddingBuildCompatible(
  artifact: EmbeddingArtifact,
  build: { model?: string | null; dimension?: number | null },
): boolean {
  if (!build) return false;
  if (typeof build.dimension === "number" && build.dimension !== artifact.dimension) {
    return false;
  }
  if (typeof build.model === "string" && build.model && build.model !== artifact.id) {
    return false;
  }
  return true;
}
